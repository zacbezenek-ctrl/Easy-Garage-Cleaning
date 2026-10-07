/* Commission, pay periods and payroll rows for canvassing reps.
   Commission is earned only when a sale is completed, paid and past its cancellation deadline.
   The accelerator applies to the part of a rep's collected revenue above the monthly threshold,
   counted in the order payments were collected (calendar month in the company time zone). */
import { addDays, validDate, zonedDate } from './knock-time.js';

const money = value => Math.round(Number(value || 0) * 100) / 100;
const ms = value => (typeof value === 'number' ? value : Date.parse(value));

export function collectedAmount(sale) {
  if (sale?.status !== 'paid') return 0;
  const value = Number(sale.collectedAmount ?? sale.ticket);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// The instant commission becomes earned, or null if it is not (yet) earned.
export function earnedAt(sale) {
  if (sale?.status !== 'paid' || !sale.paidAt) return null;
  const times = [ms(sale.paidAt), ms(sale.completedAt || sale.paidAt), ms(sale.cancelEndsAt)];
  return times.every(Number.isFinite) ? Math.max(...times) : null;
}

export function isEarned(sale, now = Date.now()) {
  const at = earnedAt(sale);
  return at != null && now >= at;
}

/* Commission on `amount` of collected revenue when `running` was already collected this month:
   the base rate up to the accelerator threshold, the accelerator rate above it. */
export function tieredCommission(running, amount, commission) {
  const rate = Number(commission?.rate ?? 0.25);
  if (commission?.acceleratorEnabled === false) return { base: money(amount * rate), accelerator: 0 };
  const threshold = Number(commission?.acceleratorThreshold ?? 8000);
  const below = Math.max(0, Math.min(amount, threshold - running));
  return { base: money(below * rate), accelerator: money((amount - below) * Number(commission?.acceleratorRate ?? 0.3)) };
}

/* Commission per earned sale. Returns [{ saleId, repKey, month, collected, base, accelerator, total, earnedAt }]. */
export function saleCommissions(sales, commission, { now = Date.now(), timeZone = 'America/Denver' } = {}) {
  const groups = new Map();
  for (const sale of sales || []) {
    if (!isEarned(sale, now)) continue;
    const month = zonedDate(ms(sale.paidAt), timeZone).slice(0, 7);
    const key = `${sale.repKey}|${month}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sale);
  }
  const rows = [];
  for (const group of groups.values()) {
    group.sort((a, b) => (ms(a.paidAt) - ms(b.paidAt)) || String(a.id).localeCompare(String(b.id)));
    let running = 0;
    for (const sale of group) {
      const collected = collectedAmount(sale);
      const { base, accelerator } = tieredCommission(running, collected, commission);
      running += collected;
      rows.push({
        saleId: sale.id, repKey: sale.repKey, month: zonedDate(ms(sale.paidAt), timeZone).slice(0, 7),
        collected: money(collected), base, accelerator, total: money(base + accelerator), earnedAt: earnedAt(sale),
      });
    }
  }
  return rows;
}

// Commission on one rep's collected revenue for a whole calendar month.
export function monthlyCommission(collected, commission) {
  const { base, accelerator } = tieredCommission(0, Number(collected || 0), commission);
  return money(base + accelerator);
}

/* Lead override: a share of each team member's collected revenue, paid to the lead recorded on
   the sale when it was booked. The lead's own sales earn ordinary commission, not an override. */
export function leadOverrides(sales, commission, { now = Date.now() } = {}) {
  if (commission?.leadOverrideEnabled === false) return [];
  const rate = Number(commission?.leadOverrideRate ?? 0.03);
  return (sales || [])
    .filter(sale => sale.leadKey && sale.leadKey !== sale.repKey && isEarned(sale, now))
    .map(sale => ({ saleId: sale.id, leadKey: sale.leadKey, repKey: sale.repKey, amount: money(collectedAmount(sale) * rate), earnedAt: earnedAt(sale) }));
}

// Commission a booked sale would pay at the base rate (for "pending").
export const projectedCommission = (sale, commission) => sale?.status === 'cancelled' ? 0 : money(Number(sale?.ticket || 0) * Number(commission?.rate ?? 0.25));

/* ---- Pay periods ---- */

function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
}

function lastDayOfMonth(date) {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

// The pay period containing a date: { key, start, end } (inclusive dates).
export function payPeriodFor(date, payroll) {
  if (!validDate(date)) return null;
  const period = payroll?.period || 'biweekly';
  if (period === 'monthly') {
    const start = date.slice(0, 8) + '01';
    return { key: `${start}_${lastDayOfMonth(date)}`, start, end: lastDayOfMonth(date) };
  }
  if (period === 'semimonthly') {
    const day = Number(date.slice(8, 10));
    const start = date.slice(0, 8) + (day <= 15 ? '01' : '16');
    const end = day <= 15 ? date.slice(0, 8) + '15' : lastDayOfMonth(date);
    return { key: `${start}_${end}`, start, end };
  }
  const length = period === 'weekly' ? 7 : 14;
  const anchor = validDate(payroll?.anchorDate) ? payroll.anchorDate : '2026-10-05';
  const offset = Math.floor(daysBetween(anchor, date) / length) * length;
  const start = addDays(anchor, offset);
  const end = addDays(start, length - 1);
  return { key: `${start}_${end}`, start, end };
}

export function previousPayPeriod(period, payroll) {
  return payPeriodFor(addDays(period.start, -1), payroll);
}

const inPeriod = (date, period) => Boolean(date && period && date >= period.start && date <= period.end);

/* Per rep for one pay period:
   booked   - revenue of sales sold in the period that are not cancelled
   pending  - base-rate commission on those sales that is not earned yet
   earned   - commission (incl. accelerator) that became earned in the period
   override - lead override that became earned in the period
   paid     - payouts recorded against the period */
export function periodStatement({ sales = [], payouts = [], training = [], reps = [], settings, period, now = Date.now(), timeZone = 'America/Denver' }) {
  const commission = settings?.commission || {};
  const trainingRate = Number(settings?.payroll?.trainingHourlyRate ?? 15.16);
  const commissions = saleCommissions(sales, commission, { now, timeZone });
  const overrides = leadOverrides(sales, commission, { now });
  const byRep = new Map();
  const row = repKey => {
    if (!byRep.has(repKey)) {
      const rep = reps.find(r => r.repKey === repKey);
      byRep.set(repKey, {
        repKey, name: rep?.displayName || repKey, salesBooked: 0, booked: 0, pending: 0,
        earned: 0, accelerator: 0, override: 0, paid: 0, trainingMinutes: 0, trainingPay: 0,
      });
    }
    return byRep.get(repKey);
  };
  for (const rep of reps) if (rep.status === 'active') row(rep.repKey);
  for (const sale of sales) {
    const soldDate = sale.saleDate || zonedDate(ms(sale.soldAt), timeZone);
    if (!inPeriod(soldDate, period) || sale.status === 'cancelled') continue;
    const r = row(sale.repKey);
    r.salesBooked += 1;
    r.booked = money(r.booked + Number(sale.ticket || 0));
    if (!isEarned(sale, now)) r.pending = money(r.pending + projectedCommission(sale, commission));
  }
  for (const item of commissions) {
    if (!inPeriod(zonedDate(item.earnedAt, timeZone), period)) continue;
    const r = row(item.repKey);
    r.earned = money(r.earned + item.total);
    r.accelerator = money(r.accelerator + item.accelerator);
  }
  for (const item of overrides) {
    if (!inPeriod(zonedDate(item.earnedAt, timeZone), period)) continue;
    const r = row(item.leadKey);
    r.override = money(r.override + item.amount);
  }
  for (const payout of payouts) {
    if (payout.periodKey !== period.key) continue;
    const r = row(payout.repKey);
    r.paid = money(r.paid + Number(payout.amount || 0));
  }
  for (const log of training) {
    if (!inPeriod(log.date, period)) continue;
    const r = row(log.repKey);
    r.trainingMinutes += Number(log.minutes || 0);
  }
  for (const r of byRep.values()) {
    r.trainingPay = money(r.trainingMinutes / 60 * trainingRate);
    r.balance = money(r.earned + r.override - r.paid);
  }
  return [...byRep.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ---- CSV ---- */

export function csvCell(value) {
  let text = value == null ? '' : String(value);
  // Neutralize spreadsheet formulas in free text.
  if (/^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header, rows) {
  return [header, ...rows].map(cols => cols.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function commissionCsv(statement, period) {
  return toCsv(
    ['period_start', 'period_end', 'rep', 'username', 'sales_booked', 'booked_revenue', 'pending_commission', 'earned_commission', 'accelerator_included', 'lead_override', 'paid', 'balance_due'],
    statement.map(r => [period.start, period.end, r.name, r.repKey, r.salesBooked, r.booked.toFixed(2), r.pending.toFixed(2), r.earned.toFixed(2), r.accelerator.toFixed(2), r.override.toFixed(2), r.paid.toFixed(2), r.balance.toFixed(2)]),
  );
}

export function trainingCsv(training, reps, period, hourlyRate) {
  const rows = training
    .filter(log => inPeriod(log.date, period))
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.repKey).localeCompare(String(b.repKey)))
    .map(log => {
      const rep = reps.find(r => r.repKey === log.repKey);
      const hours = Number(log.minutes || 0) / 60;
      return [log.date, rep?.displayName || log.repKey, log.repKey, log.minutes, hours.toFixed(2), Number(hourlyRate).toFixed(2), money(hours * hourlyRate).toFixed(2), log.note || ''];
    });
  return toCsv(['date', 'rep', 'username', 'minutes', 'hours', 'hourly_rate', 'pay', 'note'], rows);
}
