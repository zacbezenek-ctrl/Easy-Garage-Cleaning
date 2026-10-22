// Money and scoreboard reports. Reps see their own numbers, leads their team's scoreboard, admins
// everyone's money and the payroll exports. Built from day summaries (knock_days), sales, payouts
// and training logs; every rate and target comes from settings.
import { knockFailure, write } from './knock-store.js';
import { listReps } from './knock-admin.js';
import { loadNeighborhoods } from './knock-territory.js';
import { addDays, validDate, zonedDate } from '../../crew/knock-time.js';
import { CHANNEL_LOOKBACK_DAYS, commissionCsv, commissionEligibility, commissionIssues, customerCollection, csvCell, earnedAt, isEarned, leadOverrides, payPeriodFor, periodStatement, previousPayPeriod, projectedCommission, saleCommissions, toCsv, trainingCsv } from '../../crew/knock-money.js';
import { saleSyncSummaries } from './knock-handoff.js';
import { setterAttributions, setterBatchReaderFor } from './knock-setters.js';
import { ESTIMATOR_SETTER_LIMIT, channelEarnings, channelLedger, estimatorLedger } from './estimator-commission.js';
import { loadSettings, loadSetterTerms } from './knock-access.js';
import { dispatchStorage } from './dispatch-storage.js';
import { hubJobsForSales, knockJobBridgeEnabled, saleJobView } from './knock-bridge.js';
import { emptyTotals, addTotals, gateStatus, metrics, planComparison, scoreboard, teamTotals } from '../../crew/knock-stats.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clean = ({ __updateTime, ...row }) => row;

export function periodFromParams(params, settings, nowMs) {
  const date = params?.get('date') || zonedDate(nowMs);
  if (!validDate(date)) throw knockFailure('Bad date.', 400, 'knock_invalid_date');
  return payPeriodFor(date, settings.payroll);
}

function range(params, nowMs) {
  const today = zonedDate(nowMs);
  const preset = params?.get('range') || 'week';
  let from = params?.get('from') || '', to = params?.get('to') || '';
  if (!from || !to) {
    to = today;
    from = preset === 'today' ? today : preset === 'week' ? addDays(today, -6) : preset === 'month' ? today.slice(0, 8) + '01' : preset === 'season' ? `${today.slice(0, 4)}-01-01` : '2000-01-01';
  }
  if (!validDate(from) || !validDate(to) || from > to) throw knockFailure('Bad date range.', 400, 'knock_invalid_range');
  return { from, to, preset };
}

async function loadMoney(store, { repKey = null } = {}) {
  const [sales, payouts, training] = await Promise.all([
    repKey ? store.query('knock_sales', { where: [['repKey', '==', repKey]] }) : store.list('knock_sales'),
    repKey ? store.query('knock_payouts', { where: [['repKey', '==', repKey]] }) : store.list('knock_payouts'),
    repKey ? store.query('knock_training', { where: [['repKey', '==', repKey]] }) : store.list('knock_training'),
  ]);
  return { sales: sales.map(clean), payouts: payouts.map(clean), training: training.map(clean) };
}

/* A rep's own setter records (appointment setting, 13% / 7%; a walkthrough they ran themselves, the door-sale 25%), as
   the rep sees them: the estimator, whoever closed the job
   and any other rep's direct sale stay with the office (Admin > Setters lists them); of the allocations only the rep's own
   setter share is shown, never the estimator's pay. The bridge (knock-bridge.js) records the estimator on every door
   walkthrough, whose staff key a rep otherwise never learns (estimatorRef). */
export function repSetterRows(setters, repKey) {
  const rows = (setters?.rows || []).filter(row => row?.setterKey === repKey).map(({ estimatorKey, closingActorKey, directSaleRepKey, allocations, adjustment, ...row }) => ({
    ...row, allocations: (Array.isArray(allocations) ? allocations : []).filter(item => ['setter', 'direct_rep'].includes(item?.role) && item.repKey === repKey) }));
  return { ...setters, rows };
}

/* What a rep's statement adds once the owner approved the setter terms, read the way Admin > Money reads it
   (estimator-commission.js channelLedger): their setter records made in the lookback of the periods shown, newest first
   and at most ESTIMATOR_SETTER_LIMIT, and, for an employee who also signs walkthroughs, their own estimator 7% (one
   key, one statement, so My money and Admin > Money agree). Answers {setters, channels, channelHolds, channelReview}. */
async function repChannels({ store, rep, env, dispatch, terms, nowMs, since }) {
  const mine = (await store.query('knock_setters', { where: [['setterKey', '==', rep.repKey]] }))
    .filter(row => typeof row.recordedAt === 'string' && row.recordedAt >= since).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const setters = await setterAttributions(store, env, { rows: mine, nowMs, terms, limit: ESTIMATOR_SETTER_LIMIT, ...(dispatch ? { readJobs: setterBatchReaderFor(dispatch(env)) } : {}) });
  const estimator = dispatch ? await estimatorLedger({ kstore: store, dispatch: dispatch(env), env, estimatorKey: rep.repKey, actorId: rep.username || rep.repKey, terms, nowMs }) : null;
  const ledger = channelLedger({ setters: { rows: [...setters.rows, ...(estimator?.setters.rows || [])] }, rows: estimator?.rows || [], overflow: [...mine.slice(ESTIMATOR_SETTER_LIMIT), ...(estimator?.overflow || [])] });
  const channels = [...new Map(ledger.items.filter(item => item.repKey === rep.repKey).map(item => [item.id, item])).values()];
  return { setters, channels, channelHolds: ledger.holds.filter(hold => hold.repKey === rep.repKey), channelReview: ledger.review };
}

/* A rep's pay: this period and the five before, plus each sale's commission state. Once the owner approved the setter
   terms, the rep's earned setter shares (and estimator shares, when they also sign walkthroughs) count in their periods
   too, with the same holds as Admin > Money (repChannels). */
async function myMoney({ store, rep, settings, nowMs, params, env, dispatch = null }) {
  const own = await loadMoney(store, { repKey: rep.repKey });
  // A lead's override comes from their team's sales, so those are read too (amounts only, no customers).
  const team = rep.role === 'lead' ? (await store.query('knock_sales', { where: [['leadKey', '==', rep.repKey]] })).map(clean) : [];
  const sales = [...own.sales, ...team.filter(s => s.repKey !== rep.repKey)];
  const terms = await loadSetterTerms(store, settings);
  const shown = [periodFromParams(params, settings, nowMs)];
  while (shown.length < 6) shown.push(previousPayPeriod(shown.at(-1), settings.payroll));
  const { setters, channels = null, channelHolds = [], channelReview = [] } = terms.verified
    ? await repChannels({ store, rep, env, dispatch, terms, nowMs, since: addDays(shown.at(-1).start, -CHANNEL_LOOKBACK_DAYS) })
    : { setters: await setterAttributions(store, env, { repKey: rep.repKey, nowMs, terms, ...(dispatch ? { readJobs: setterBatchReaderFor(dispatch(env)) } : {}) }) };
  const periods = shown.map(period => {
    const [row] = periodStatement({ sales, payouts: own.payouts, training: own.training, reps: [{ ...rep, status: 'active' }], settings, period, now: nowMs, channels, channelReview, channelHolds }).filter(r => r.repKey === rep.repKey);
    return { period, ...(row || { booked: 0, pending: 0, earned: 0, accelerator: 0, override: 0, paid: 0, balance: 0, salesBooked: 0, trainingMinutes: 0, trainingPay: 0 }) };
  });
  const commissions = new Map(saleCommissions(own.sales, settings.commission, { now: nowMs }).map(c => [c.saleId, c]));
  const sync = await saleSyncSummaries(store, own.sales);
  // KNOCK-BRIDGE: each statement line names its Hub job's day, crew label and status (one masked read of those jobs).
  // READ-BUDGET: only for the lines My money lists (sold or paid in the pay period asked for, crew/knock-stats-ui.js),
  // never every bridged sale of the season; any other sale keeps its booking view without the live read.
  const listed = ({ start, end }) => sale => sale.saleDate >= start && sale.saleDate <= end || Boolean(sale.paidAt) && zonedDate(sale.paidAt) >= start && zonedDate(sale.paidAt) <= end;
  const hub = dispatch && knockJobBridgeEnabled(env) ? await hubJobsForSales(dispatch(env), own.sales.filter(listed(periods[0].period))).catch(() => new Map()) : null;
  const bySale = own.sales.sort((a, b) => String(b.soldAt).localeCompare(String(a.soldAt))).map(sale => ({
    id: sale.id, saleDate: sale.saleDate, address: sale.address, package: sale.package, ticket: sale.ticket, status: sale.status,
    collectedAmount: sale.collectedAmount, cancelDeadlineDate: sale.cancelDeadlineDate, jobDate: sale.jobDate,
    completedAt: sale.completedAt || null, paidAt: sale.paidAt || null,
    customerCollection: customerCollection(sale), sync: sync.get(sale.id), eligibility: commissionEligibility(sale),
    reviewReasons: commissionIssues(sale, settings.commission),
    ...(hub && sale.handoff?.job?.mode === 'hub' ? { job: { ...saleJobView(sale), ...(hub.get(sale.id) ? { live: hub.get(sale.id) } : {}) } } : {}),
    commission: settings.commission.verified === false ? { state: 'unconfigured', amount: null }
      : commissionIssues(sale, settings.commission).length ? { state: 'review_required', amount: null }
      : commissionEligibility(sale) === 'excluded' ? { state: 'excluded', amount: 0 }
      : sale.status === 'cancelled' ? { state: 'cancelled', amount: 0 }
      : isEarned(sale, nowMs) ? { state: 'earned', amount: commissions.get(sale.id)?.total ?? 0, earnedAt: new Date(earnedAt(sale)).toISOString() }
      : { state: 'pending', amount: projectedCommission(sale, settings.commission) },
  }));
  const overrides = rep.role === 'lead' ? leadOverrides(team, settings.commission, { now: nowMs }).filter(o => o.leadKey === rep.repKey) : [];
  return { periods, sales: bySale, setters: repSetterRows(setters, rep.repKey),
    overrides: overrides.map(o => ({ amount: o.amount, earnedAt: new Date(o.earnedAt).toISOString() })), rates: settings.commission, trainingHourlyRate: settings.payroll.trainingHourlyRate };
}

/* Scoreboard rows for the viewer's scope: a rep sees themselves, a lead their team, an admin all. */
async function scoreboardView({ store, rep, settings, admin, nowMs, params }) {
  const { from, to, preset } = range(params, nowMs);
  const groupBy = ['rep', 'team', 'neighborhood', 'day'].includes(params?.get('groupBy')) ? params.get('groupBy') : 'rep';
  const [reps, neighborhoods] = await Promise.all([listReps(store), loadNeighborhoods(store)]);
  const scope = admin ? null : rep.role === 'lead' ? new Set([rep.repKey, ...reps.filter(r => r.leadKey === rep.repKey).map(r => r.repKey)]) : new Set([rep.repKey]);
  const allDays = scope && scope.size === 1
    ? await store.query('knock_days', { where: [['repKey', '==', rep.repKey]] })
    : await store.list('knock_days');
  const days = allDays.map(clean).filter(d => d.date >= from && d.date <= to && (!scope || scope.has(d.repKey)));
  const rows = scoreboard(days, { groupBy, reps, neighborhoods: neighborhoods.map(n => ({ id: n.id, name: n.name })) });
  const team = teamTotals(days);
  const body = {
    range: { from, to, preset }, groupBy, scope: admin ? 'all' : rep.role === 'lead' ? 'team' : 'self',
    rows: rows.map(r => ({ key: r.key, label: r.label, metrics: r.metrics, plan: settings.plan.verified ? planComparison(r.metrics, settings.plan) : [] })),
    totals: { metrics: team.metrics, plan: settings.plan.verified ? planComparison(team.metrics, settings.plan) : [] },
    car: { withCar: team.metrics.carLookRate, withoutCar: team.metrics.noCarLookRate, answersWithCar: team.totals.car.answers, answersWithoutCar: team.totals.noCar.answers },
    planTargets: settings.plan.verified ? settings.plan : null, benchmarkState: settings.plan.verified ? 'configured' : 'unconfigured',
  };
  if (admin && settings.plan.verified) {
    // The go/fix/stop gate is the company's question, over every knocking hour so far.
    const lifetime = teamTotals(allDays.map(clean));
    body.gate = { hours: lifetime.metrics.knockingHours, revenuePerHour: lifetime.metrics.revenuePerHour, ...gateStatus(lifetime.metrics.knockingHours, lifetime.metrics.revenuePerHour, settings.gate), thresholds: settings.gate };
  }
  return body;
}

export const reportViews = {
  'my-money': myMoney,
  scoreboard: scoreboardView,
};

/* ---------- admin money ---------- */

/* Admin > Money. `channels` are the approved setter and estimator shares (estimator-commission.js channelEarnings:
   {items, holds, review}, null before the owner's approval): they join the statement as earned commission, with their holds. */
export async function moneyView(store, params, nowMs, settings, { channels = null } = {}) {
  const period = periodFromParams(params, settings, nowMs);
  const [{ sales, payouts, training }, reps] = await Promise.all([loadMoney(store), listReps(store)]);
  const statement = periodStatement({ sales, payouts, training, reps, settings, period, now: nowMs, channels: channels?.items ?? null, channelReview: channels?.review || [], channelHolds: channels?.holds || [] });
  return {
    period, previous: previousPayPeriod(period, settings.payroll), next: payPeriodFor(addDays(period.end, 1), settings.payroll),
    statement, payouts: payouts.filter(p => p.periodKey === period.key).sort((a, b) => String(b.paidAt).localeCompare(String(a.paidAt))),
    rates: settings.commission, trainingHourlyRate: settings.payroll.trainingHourlyRate, payroll: settings.payroll,
  };
}

export async function exportCsv(store, params, nowMs, settings, { channels = null } = {}) {
  const kind = params.get('kind') || 'commission';
  const period = periodFromParams(params, settings, nowMs);
  if (period.configured === false) throw knockFailure('The two-week payroll anchor is unconfigured. Preview dates cannot be exported as a payroll cycle.', 409, 'knock_payroll_unconfigured');
  const [{ sales, payouts, training }, reps] = await Promise.all([loadMoney(store), listReps(store)]);
  if (kind === 'commission') {
    const statement = periodStatement({ sales, payouts, training, reps, settings, period, now: nowMs, channels: channels?.items ?? null, channelReview: channels?.review || [], channelHolds: channels?.holds || [] });
    return { csv: commissionCsv(statement, period), filename: `egc-knock-commission-${period.start}-${period.end}.csv` };
  }
  if (kind === 'training') {
    return { csv: trainingCsv(training, reps, period, settings.commission.verified ? settings.payroll.trainingHourlyRate : null), filename: `egc-knock-training-${period.start}-${period.end}.csv` };
  }
  if (kind === 'sales') {
    const commissions = new Map(saleCommissions(sales, settings.commission, { now: nowMs }).map(c => [c.saleId, c]));
    const rows = sales.filter(s => s.saleDate >= period.start && s.saleDate <= period.end).sort((a, b) => String(a.soldAt).localeCompare(String(b.soldAt))).map(s => [
      s.saleDate, reps.find(r => r.repKey === s.repKey)?.displayName || s.repKey, s.repKey, `${s.address.number} ${s.address.street}${s.address.unit ? ` #${s.address.unit}` : ''}`,
      s.package, Number(s.ticket).toFixed(2), Number(s.depositAmount).toFixed(2), s.status, s.collectedAmount == null ? '' : Number(s.collectedAmount).toFixed(2),
      s.cancelDeadlineDate, s.jobDate, settings.commission.verified === false || commissionIssues(s, settings.commission).length ? '' : (commissions.get(s.id)?.total ?? 0).toFixed(2), s.handoff?.deposit?.status || '', s.handoff?.job?.status || '',
    ]);
    return { csv: toCsv(['sale_date', 'rep', 'username', 'address', 'package', 'ticket', 'deposit', 'status', 'collected', 'cancel_deadline', 'job_date', 'commission_earned', 'deposit_status', 'job_status'], rows), filename: `egc-knock-sales-${period.start}-${period.end}.csv` };
  }
  throw knockFailure('Unknown export.', 400, 'knock_unknown_export');
}

/* An estimator paid their 7% (estimator-commission.js) may be Hub staff with no canvassing profile: once the owner
   approved the setter terms, a payout may name a staff key on the dispatch roster. */
async function estimatorRecipient(store, env, dispatch, key) {
  if (!/^[a-z0-9._-]{1,64}$/.test(key) || !(await loadSetterTerms(store, await loadSettings(store))).verified) return null;
  return (await dispatch(env).roster()).some(person => person?.id === key) ? { id: key } : null;
}

/* D6b: once the owner approved the setter terms, a payout records the walkthrough-setting and estimator shares its
   recipient has in that pay period's statement as it reads now (channelItems: {id, share, amountCents, earnedAt}), so a
   share that later changes, moves or is earned again holds the statements for finance instead of being paid twice
   (crew/knock-money.js periodStatement). Before the approval the payout is exactly as before. */
async function payoutChannelItems(store, env, dispatch, repKey, periodKey, nowMs) {
  const terms = await loadSetterTerms(store, await loadSettings(store));
  if (!terms.verified) return null;
  const [start, end] = periodKey.split('_'), windowStart = Date.parse(addDays(start, -CHANNEL_LOOKBACK_DAYS));
  const channels = await channelEarnings({ kstore: store, dispatch: dispatch(env), env, terms, nowMs, period: { key: periodKey, start, end } });
  // The shares the statement counts for this recipient and period (periodStatement: earned in it, source in its lookback).
  return channels.items.filter(item => item.repKey === repKey && zonedDate(item.earnedAt) >= start && zonedDate(item.earnedAt) <= end && item.sourceAt >= windowStart)
    .map(item => ({ id: item.id, share: item.share, amountCents: Math.round(item.amount * 100), earnedAt: new Date(item.earnedAt).toISOString() }));
}

export async function addPayout(store, admin, { requestId, repKey, periodKey, amount, note }, nowIso, env = {}, { dispatch = dispatchStorage } = {}) {
  if (!UUID.test(String(requestId || ''))) throw knockFailure('Missing request id. Reload and retry.', 400, 'knock_invalid_request');
  if (!/^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/.test(String(periodKey || ''))) throw knockFailure('Pick the pay period.', 400, 'knock_invalid_period');
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0 || value > 100000) throw knockFailure('Enter the amount paid.', 400, 'knock_invalid_amount');
  const rep = await store.get('knock_reps', String(repKey || '')) || await estimatorRecipient(store, env, dispatch, String(repKey || ''));
  if (!rep) throw knockFailure('That rep was not found.', 404, 'knock_rep_missing');
  const existing = await store.get('knock_payouts', requestId);
  const payout = { repKey: rep.id, periodKey, amount: Math.round(value * 100) / 100, note: String(note || '').slice(0, 200), paidAt: nowIso, by: admin.user };
  const replay = saved => {
    if (['repKey', 'periodKey', 'amount', 'note'].some(key => saved[key] !== payout[key])) throw knockFailure('This request id already records a different payout. Refresh and review the recorded payment.', 409, 'knock_payout_conflict');
    return { duplicate: true, payout: clean(saved) };
  };
  if (existing) return replay(existing);
  const channelItems = await payoutChannelItems(store, env, dispatch, payout.repKey, periodKey, Date.parse(nowIso));
  if (channelItems) payout.channelItems = channelItems;
  try { await store.commit([write.create('knock_payouts', requestId, payout)]); }
  catch (error) {
    const saved = await store.get('knock_payouts', requestId);
    if (saved) return replay(saved);
    throw error;
  }
  return { duplicate: false, payout: { id: requestId, ...payout } };
}

export { csvCell, emptyTotals, addTotals, metrics };
