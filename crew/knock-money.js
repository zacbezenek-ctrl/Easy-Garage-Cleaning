/* Commission, pay periods and payroll rows for canvassing reps.
   Commission is earned only when a sale is completed, paid and past its cancellation deadline.
   The accelerator applies to the part of a rep's collected revenue above the monthly threshold,
   counted in the order payments were collected (calendar month in the company time zone). */
import { addDays, validDate, zonedDate } from './knock-time.js';

const money = value => Math.round(Number(value || 0) * 100) / 100;
const ms = value => (typeof value === 'number' ? value : Date.parse(value));
const TERM_FIELDS = ['rate', 'acceleratorEnabled', 'acceleratorThreshold', 'acceleratorRate', 'leadOverrideEnabled', 'leadOverrideRate'];

// Created only by the server when booking under an evidenced contract. Current
// settings must never replace the terms captured on an older sale.
export function snapshotCommissionTerms(commission) {
  if (commission?.verified !== true || !Number.isFinite(ms(commission.approvedAt))) return null;
  return { contract: 'knock-v1', approvedAt: commission.approvedAt,
    policy: Object.fromEntries(TERM_FIELDS.map(key => [key, commission[key]])) };
}

function saleTerms(sale, commission) {
  const terms = sale?.commissionTerms;
  if (terms != null) {
    const p = terms.policy;
    if (terms.contract !== 'knock-v1' || !Number.isFinite(ms(terms.approvedAt)) ||
      !['rate', 'acceleratorRate', 'leadOverrideRate'].every(key => typeof p?.[key] === 'number' && p[key] >= 0 && p[key] <= 1) ||
      !['acceleratorEnabled', 'leadOverrideEnabled'].every(key => typeof p?.[key] === 'boolean') ||
      !Number.isFinite(p?.acceleratorThreshold) || p.acceleratorThreshold <= 0) return null;
    return p;
  }
  // Arithmetic-only callers can exercise the legacy calculator. Server reports
  // always supply verified true/false and never use this fallback for history.
  return commission?.verified === undefined ? commission : null;
}

export function collectedAmount(sale) {
  return customerCollection(sale).gross ?? 0;
}

// The final collection snapshot includes any deposit; never add them together.
// These are recorded receipts, not a bank reconciliation or a payment to a rep.
export function customerCollection(sale) {
  const amount = value => value !== null && value !== undefined && value !== '' &&
    Number.isFinite(Number(value)) && Number(value) >= 0 ? money(value) : null;
  const final = amount(sale?.collectedAmount);
  const deposit = sale?.handoff?.deposit;
  const gross = final ?? (deposit?.status === 'collected' && ['admin', 'stripe'].includes(deposit.verifiedBy)
    ? amount(deposit.collectedAmount) : null);
  const refunded = sale?.refundedAmount == null ? 0 : amount(sale.refundedAmount);
  const at = final !== null ? sale?.paidAt : deposit?.collectedAt;
  return { gross, refunded, net: gross !== null && refunded !== null && refunded <= gross ? money(gross - refunded) : null,
    at: Number.isFinite(ms(at)) ? at : null, source: final !== null ? 'admin_recorded_snapshot' : gross !== null ? `${deposit.verifiedBy}_deposit` : 'missing',
    settlement: 'not_reconciled' };
}

function collectionEvents(sale) {
  const history = sale.collectionHistory;
  if (!Array.isArray(history) || !history.length) {
    const { gross, at } = customerCollection(sale);
    return gross !== null && at ? [{ amount: gross, at }] : [];
  }
  const first = history[0];
  return [
    ...(first?.previousTotal > 0 && first?.previousAt ? [{ amount: first.previousTotal, at: first.previousAt }] : []),
    ...history.map(event => ({ amount: money(event?.total - event?.previousTotal), at: event?.at })),
  ].filter(event => Number.isFinite(event.amount) && event.amount >= 0 && Number.isFinite(ms(event.at)));
}

export function commissionIssues(sale, commission) {
  const payment = customerCollection(sale), issues = [];
  if ((sale?.commissionTerms != null || commission?.verified === true) && !saleTerms(sale, commission)) issues.push('commission_terms_missing_or_invalid');
  if (sale?.status === 'paid') {
    if (!sale.completedAt || !Number.isFinite(ms(sale.completedAt))) issues.push('completion_unverified');
    if (!sale.paidAt || !Number.isFinite(ms(sale.paidAt)) || payment.gross === null) issues.push('collection_unverified');
    if (payment.gross !== null && money(payment.gross) !== money(sale.ticket)) issues.push('partial_or_excess_collection');
    if (!Number.isFinite(ms(sale.cancelEndsAt))) issues.push('cancellation_deadline_missing');
  }
  if (payment.refunded === null || payment.refunded > 0) issues.push('refund_review');
  if (sale?.collectionHistory != null) {
    const history = sale.collectionHistory;
    if (!Array.isArray(history) || history.some((event, i) => !Number.isFinite(event?.total) || !Number.isFinite(event?.previousTotal) ||
      event.total < event.previousTotal || !Number.isFinite(ms(event.at)) ||
      (i > 0 && event.previousTotal !== history[i - 1].total)) ||
      (history.length && history.at(-1).total !== payment.gross)) issues.push('collection_history_invalid');
  }
  if (sale?.status === 'cancelled' && (payment.gross > 0 || sale.completedAt)) issues.push('cancellation_review');
  return issues;
}

const unique = rows => [...new Map(rows.map((row, i) => [row.id || `row-${i}`, row])).values()];

// The instant commission becomes earned, or null if it is not (yet) earned.
export function earnedAt(sale) {
  if (sale?.status !== 'paid' || commissionIssues(sale).length) return null;
  const times = [ms(sale.paidAt), ms(sale.completedAt), ms(sale.cancelEndsAt)];
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
  if (commission?.verified === false) return [];
  const groups = new Map();
  for (const sale of unique(sales || [])) {
    if (!isEarned(sale, now) || !saleTerms(sale, commission)) continue;
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
      const { base, accelerator } = tieredCommission(running, collected, saleTerms(sale, commission));
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
  if (commission?.verified === false) return [];
  return unique(sales || [])
    .filter(sale => sale.leadKey && sale.leadKey !== sale.repKey && isEarned(sale, now) && saleTerms(sale, commission)?.leadOverrideEnabled)
    .map(sale => ({ saleId: sale.id, leadKey: sale.leadKey, repKey: sale.repKey, amount: money(collectedAmount(sale) * saleTerms(sale, commission).leadOverrideRate), earnedAt: earnedAt(sale) }));
}

// Commission a booked sale would pay at the base rate (for "pending").
export const projectedCommission = (sale, commission) => commission?.verified === false || !saleTerms(sale, commission) ? null : sale?.status === 'cancelled' ? 0 : money(Number(sale?.ticket || 0) * Number(saleTerms(sale, commission).rate));

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
  sales = unique(sales);
  payouts = unique(payouts);
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
        projectedCommission: 0, customerCollectedRevenue: 0, customerRefundedRevenue: 0,
        collectionUnknownCount: 0, reviewReasons: [],
      });
    }
    return byRep.get(repKey);
  };
  for (const rep of reps) if (rep.status === 'active') row(rep.repKey);
  for (const sale of sales) {
    const r = row(sale.repKey), payment = customerCollection(sale);
    const issues = commissionIssues(sale, commission);
    // Unresolved adjustments may affect prior payouts or monthly tiers; never invent a clawback.
    r.reviewReasons.push(...issues);
    if (sale.leadKey && sale.leadKey !== sale.repKey) row(sale.leadKey).reviewReasons.push(...issues);
    for (const event of collectionEvents(sale)) {
      if (inPeriod(zonedDate(ms(event.at), timeZone), period)) r.customerCollectedRevenue = money(r.customerCollectedRevenue + event.amount);
    }
    if (payment.refunded > 0 && sale.refundedAt && inPeriod(zonedDate(ms(sale.refundedAt), timeZone), period)) {
      r.customerRefundedRevenue = money(r.customerRefundedRevenue + payment.refunded);
    }
    const soldDate = sale.saleDate || zonedDate(ms(sale.soldAt), timeZone);
    if (inPeriod(soldDate, period) && (payment.gross === null || !payment.at)) r.collectionUnknownCount += 1;
    if (!inPeriod(soldDate, period) || sale.status === 'cancelled') continue;
    r.salesBooked += 1;
    r.booked = money(r.booked + Number(sale.ticket || 0));
    r.projectedCommission = money(r.projectedCommission + (projectedCommission(sale, commission) || 0));
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
    r.commissionPaid = r.paid;
    r.commissionPaymentEvidence = 'admin_recorded_unreconciled';
    r.commissionSettled = null;
    r.reviewReasons = [...new Set(r.reviewReasons)];
    r.compensationState = commission.verified === false ? 'unconfigured' : r.reviewReasons.length ? 'review_required' : 'configured';
    if (commission.verified === false) {
      r.pending = r.projectedCommission = r.earned = r.accelerator = r.override = r.balance = null;
      r.trainingPay = null;
    } else if (r.reviewReasons.length) {
      // A refund does not prove historical earnings should be clawed back.
      // Keep the total unknown until finance supplies the adjustment decision.
      r.earned = r.accelerator = r.override = r.balance = null;
      if (r.reviewReasons.includes('commission_terms_missing_or_invalid')) r.projectedCommission = r.pending = null;
    }
    r.earnedCommission = r.earned === null ? null : money(r.earned + r.override);
    r.payableCommission = r.compensationState === 'configured' ? Math.max(0, r.balance) : null;
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
    ['period_start', 'period_end', 'rep', 'username', 'sales_booked', 'booked_revenue', 'pending_commission', 'earned_commission', 'accelerator_included', 'lead_override', 'rep_payments_recorded', 'calculated_balance', 'projected_commission', 'customer_collected_revenue', 'customer_refunded_revenue', 'payable_commission', 'compensation_state', 'review_reasons', 'collection_unknown_count', 'rep_payment_evidence', 'settled_commission'],
    statement.map(r => [period.start, period.end, r.name, r.repKey, r.salesBooked, ...[r.booked, r.pending, r.earned, r.accelerator, r.override, r.commissionPaid, r.balance, r.projectedCommission, r.customerCollectedRevenue, r.customerRefundedRevenue, r.payableCommission].map(v => v == null ? '' : v.toFixed(2)), r.compensationState, r.reviewReasons.join(';'), r.collectionUnknownCount, r.commissionPaymentEvidence, r.commissionSettled == null ? '' : r.commissionSettled.toFixed(2)]),
  );
}

export function trainingCsv(training, reps, period, hourlyRate) {
  const rows = training
    .filter(log => inPeriod(log.date, period))
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.repKey).localeCompare(String(b.repKey)))
    .map(log => {
      const rep = reps.find(r => r.repKey === log.repKey);
      const hours = Number(log.minutes || 0) / 60;
      return [log.date, rep?.displayName || log.repKey, log.repKey, log.minutes, hours.toFixed(2), hourlyRate == null ? '' : Number(hourlyRate).toFixed(2), hourlyRate == null ? '' : money(hours * hourlyRate).toFixed(2), log.note || ''];
    });
  return toCsv(['date', 'rep', 'username', 'minutes', 'hours', 'hourly_rate', 'pay', 'note'], rows);
}
