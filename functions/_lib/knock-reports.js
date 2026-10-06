// Money and scoreboard reports. Reps see their own numbers, leads their team's scoreboard, admins
// everyone's money and the payroll exports. Built from day summaries (knock_days), sales, payouts
// and training logs; every rate and target comes from settings.
import { knockFailure, write } from './knock-store.js';
import { listReps } from './knock-admin.js';
import { loadNeighborhoods } from './knock-territory.js';
import { addDays, validDate, zonedDate } from '../../crew/knock-time.js';
import { commissionCsv, csvCell, earnedAt, isEarned, leadOverrides, payPeriodFor, periodStatement, previousPayPeriod, projectedCommission, saleCommissions, toCsv, trainingCsv } from '../../crew/knock-money.js';
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

/* A rep's pay: this period and the five before, plus each sale's commission state. */
async function myMoney({ store, rep, settings, nowMs, params }) {
  const own = await loadMoney(store, { repKey: rep.repKey });
  // A lead's override comes from their team's sales, so those are read too (amounts only, no customers).
  const team = rep.role === 'lead' ? (await store.query('knock_sales', { where: [['leadKey', '==', rep.repKey]] })).map(clean) : [];
  const sales = [...own.sales, ...team.filter(s => s.repKey !== rep.repKey)];
  const periods = [];
  let period = periodFromParams(params, settings, nowMs);
  for (let i = 0; i < 6; i += 1) {
    const [row] = periodStatement({ sales, payouts: own.payouts, training: own.training, reps: [{ ...rep, status: 'active' }], settings, period, now: nowMs }).filter(r => r.repKey === rep.repKey);
    periods.push({ period, ...(row || { booked: 0, pending: 0, earned: 0, accelerator: 0, override: 0, paid: 0, balance: 0, salesBooked: 0, trainingMinutes: 0, trainingPay: 0 }) });
    period = previousPayPeriod(period, settings.payroll);
  }
  const commissions = new Map(saleCommissions(own.sales, settings.commission, { now: nowMs }).map(c => [c.saleId, c]));
  const bySale = own.sales.sort((a, b) => String(b.soldAt).localeCompare(String(a.soldAt))).map(sale => ({
    id: sale.id, saleDate: sale.saleDate, address: sale.address, package: sale.package, ticket: sale.ticket, status: sale.status,
    collectedAmount: sale.collectedAmount, cancelDeadlineDate: sale.cancelDeadlineDate,
    commission: sale.status === 'cancelled' ? { state: 'cancelled', amount: 0 }
      : isEarned(sale, nowMs) ? { state: 'earned', amount: commissions.get(sale.id)?.total ?? 0, earnedAt: new Date(earnedAt(sale)).toISOString() }
      : { state: 'pending', amount: projectedCommission(sale, settings.commission) },
  }));
  const overrides = rep.role === 'lead' ? leadOverrides(team, settings.commission, { now: nowMs }).filter(o => o.leadKey === rep.repKey) : [];
  return { periods, sales: bySale, overrides: overrides.map(o => ({ amount: o.amount, earnedAt: new Date(o.earnedAt).toISOString() })), rates: settings.commission, trainingHourlyRate: settings.payroll.trainingHourlyRate };
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
    rows: rows.map(r => ({ key: r.key, label: r.label, metrics: r.metrics, plan: planComparison(r.metrics, settings.plan) })),
    totals: { metrics: team.metrics, plan: planComparison(team.metrics, settings.plan) },
    car: { withCar: team.metrics.carLookRate, withoutCar: team.metrics.noCarLookRate, answersWithCar: team.totals.car.answers, answersWithoutCar: team.totals.noCar.answers },
    planTargets: settings.plan,
  };
  if (admin) {
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

export async function moneyView(store, params, nowMs, settings) {
  const period = periodFromParams(params, settings, nowMs);
  const [{ sales, payouts, training }, reps] = await Promise.all([loadMoney(store), listReps(store)]);
  const statement = periodStatement({ sales, payouts, training, reps, settings, period, now: nowMs });
  return {
    period, previous: previousPayPeriod(period, settings.payroll), next: payPeriodFor(addDays(period.end, 1), settings.payroll),
    statement, payouts: payouts.filter(p => p.periodKey === period.key).sort((a, b) => String(b.paidAt).localeCompare(String(a.paidAt))),
    rates: settings.commission, trainingHourlyRate: settings.payroll.trainingHourlyRate, payroll: settings.payroll,
  };
}

export async function exportCsv(store, params, nowMs, settings) {
  const kind = params.get('kind') || 'commission';
  const period = periodFromParams(params, settings, nowMs);
  const [{ sales, payouts, training }, reps] = await Promise.all([loadMoney(store), listReps(store)]);
  if (kind === 'commission') {
    const statement = periodStatement({ sales, payouts, training, reps, settings, period, now: nowMs });
    return { csv: commissionCsv(statement, period), filename: `egc-knock-commission-${period.start}-${period.end}.csv` };
  }
  if (kind === 'training') {
    return { csv: trainingCsv(training, reps, period, settings.payroll.trainingHourlyRate), filename: `egc-knock-training-${period.start}-${period.end}.csv` };
  }
  if (kind === 'sales') {
    const commissions = new Map(saleCommissions(sales, settings.commission, { now: nowMs }).map(c => [c.saleId, c]));
    const rows = sales.filter(s => s.saleDate >= period.start && s.saleDate <= period.end).sort((a, b) => String(a.soldAt).localeCompare(String(b.soldAt))).map(s => [
      s.saleDate, reps.find(r => r.repKey === s.repKey)?.displayName || s.repKey, s.repKey, `${s.address.number} ${s.address.street}${s.address.unit ? ` #${s.address.unit}` : ''}`,
      s.package, Number(s.ticket).toFixed(2), Number(s.depositAmount).toFixed(2), s.status, s.collectedAmount == null ? '' : Number(s.collectedAmount).toFixed(2),
      s.cancelDeadlineDate, s.jobDate, (commissions.get(s.id)?.total ?? 0).toFixed(2), s.handoff?.deposit?.status || '', s.handoff?.job?.status || '',
    ]);
    return { csv: toCsv(['sale_date', 'rep', 'username', 'address', 'package', 'ticket', 'deposit', 'status', 'collected', 'cancel_deadline', 'job_date', 'commission_earned', 'deposit_status', 'job_status'], rows), filename: `egc-knock-sales-${period.start}-${period.end}.csv` };
  }
  throw knockFailure('Unknown export.', 400, 'knock_unknown_export');
}

export async function addPayout(store, admin, { requestId, repKey, periodKey, amount, note }, nowIso) {
  if (!UUID.test(String(requestId || ''))) throw knockFailure('Missing request id. Reload and retry.', 400, 'knock_invalid_request');
  if (!/^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/.test(String(periodKey || ''))) throw knockFailure('Pick the pay period.', 400, 'knock_invalid_period');
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0 || value > 100000) throw knockFailure('Enter the amount paid.', 400, 'knock_invalid_amount');
  const rep = await store.get('knock_reps', String(repKey || ''));
  if (!rep) throw knockFailure('That rep was not found.', 404, 'knock_rep_missing');
  const existing = await store.get('knock_payouts', requestId);
  if (existing) return { duplicate: true, payout: clean(existing) };
  const payout = { repKey: rep.id, periodKey, amount: Math.round(value * 100) / 100, note: String(note || '').slice(0, 200), paidAt: nowIso, by: admin.user };
  await store.commit([write.create('knock_payouts', requestId, payout)]);
  return { duplicate: false, payout: { id: requestId, ...payout } };
}

export { csvCell, emptyTotals, addTotals, metrics };
