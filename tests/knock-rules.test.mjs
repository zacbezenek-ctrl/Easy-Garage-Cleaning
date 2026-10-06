import test from 'node:test';
import assert from 'node:assert/strict';
import { sunsetInstant, formatClock, knockWindow, doorAllowed, zonedInstant, zonedDate } from '../crew/knock-time.js';
import { cancellationWindow, depositAmount, depositRefundStatus, federalHolidays, isBusinessDay, jobDateAllowed } from '../crew/knock-sale-rules.js';
import { monthlyCommission, saleCommissions, leadOverrides, payPeriodFor, periodStatement, commissionCsv, csvCell } from '../crew/knock-money.js';
import { gateStatus, shiftTiming, countKnocks, metrics, planComparison, scoreboard, daySummary, coverage } from '../crew/knock-stats.js';
import { DEFAULT_SETTINGS, mergeSettings, validateSettings } from '../crew/knock-settings.js';

const FORT_COLLINS = { lat: 40.5853, lng: -105.0844 };
const rule = DEFAULT_SETTINGS.cities['fort-collins'];
const at = (date, time) => zonedInstant(date, time, 'America/Denver');

test('NOAA sunset for Fort Collins in America/Denver matches the published minutes', () => {
  const expected = { '2026-10-06': '6:34 pm', '2026-11-01': '4:57 pm', '2026-12-01': '4:34 pm', '2027-03-14': '7:06 pm' };
  for (const [date, clock] of Object.entries(expected)) {
    assert.equal(formatClock(sunsetInstant(date, FORT_COLLINS.lat, FORT_COLLINS.lng), 'America/Denver'), clock, date);
  }
});

test('the knocking window opens at 9:00, warns 15 minutes before sunset and allows a 15 minute grace to finish a door', () => {
  const date = '2026-10-06';
  assert.equal(knockWindow(rule, at(date, '08:59')).phase, 'before');
  const open = knockWindow(rule, at(date, '09:00'));
  assert.equal(open.phase, 'open');
  assert.equal(open.endLabel, '6:34 pm');
  assert.equal(open.warning, false);
  assert.equal(knockWindow(rule, at(date, '18:18')).warning, false);
  assert.equal(knockWindow(rule, at(date, '18:19')).warning, true);
  const grace = knockWindow(rule, at(date, '18:40'));
  assert.equal(grace.phase, 'grace');
  assert.deepEqual(doorAllowed(grace), { allowed: false, afterEnd: true });
  assert.deepEqual(doorAllowed(grace, { finishingDoor: true }), { allowed: true, afterEnd: true });
  assert.equal(knockWindow(rule, at(date, '18:49')).phase, 'closed');
  assert.deepEqual(doorAllowed(knockWindow(rule, at(date, '18:50')), { finishingDoor: true }), { allowed: false, afterEnd: true });
});

test('a city rule can replace sunset with a fixed end time', () => {
  const window = knockWindow({ ...rule, startTime: '10:00', end: '19:30' }, at('2026-06-20', '19:00'));
  assert.equal(window.phase, 'open');
  assert.equal(window.endLabel, '7:30 pm');
  assert.equal(window.startLabel, '10:00 am');
});

test('cancellation deadline: midnight at the end of the third business day, Saturdays count, Sundays and federal holidays do not', () => {
  const tuesday = cancellationWindow('2026-10-06');
  assert.equal(tuesday.deadlineDate, '2026-10-09');
  assert.equal(tuesday.earliestJobDate, '2026-10-10');
  assert.equal(zonedDate(tuesday.cancelEndsAt), '2026-10-10');
  assert.equal(new Date(tuesday.cancelEndsAt).toISOString(), '2026-10-10T06:00:00.000Z');

  const friday = cancellationWindow('2026-10-09');
  assert.equal(friday.deadlineDate, '2026-10-14', 'Sunday 10/11 and Columbus Day 10/12 are skipped');
  assert.deepEqual(friday.skipped, ['2026-10-11', '2026-10-12']);
  assert.equal(friday.earliestJobDate, '2026-10-15');
  assert.equal(jobDateAllowed('2026-10-14', '2026-10-09'), false);
  assert.equal(jobDateAllowed('2026-10-15', '2026-10-09'), true);
});

test('federal holidays include observed weekdays, and both the date and the observed day are skipped', () => {
  const dates = federalHolidays(2026).map(h => h.date);
  assert.ok(dates.includes('2026-07-03') && dates.includes('2026-07-04'));
  assert.equal(isBusinessDay('2026-07-03'), false);
  assert.equal(isBusinessDay('2026-07-04'), false);
  assert.equal(isBusinessDay('2026-10-10'), true, 'Saturday is a business day');
  assert.equal(isBusinessDay('2026-11-26'), false, 'Thanksgiving');
  assert.equal(isBusinessDay('2026-10-05', ['2026-10-05']), false, 'extra holidays from settings');
  // New Year's Day 2028 is a Saturday, observed Friday Dec 31 2027.
  assert.equal(isBusinessDay('2027-12-31'), false);
});

test('deposit is 20% of the ticket, fully refundable until the deadline, then until 24 hours before the job', () => {
  assert.equal(depositAmount(1600, 0.2), 320);
  assert.equal(depositAmount(1234.56, 0.2), 246.91);
  const window = cancellationWindow('2026-10-06');
  const base = { cancelEndsAt: window.cancelEndsAt, jobDate: '2026-10-20', jobStartTime: '08:00' };
  assert.equal(depositRefundStatus(base, at('2026-10-09', '23:59')).status, 'full_cancel_right');
  assert.equal(depositRefundStatus(base, at('2026-10-10', '00:00')).status, 'refundable');
  assert.equal(depositRefundStatus(base, at('2026-10-19', '07:59')).status, 'refundable');
  assert.equal(depositRefundStatus(base, at('2026-10-19', '08:00')).status, 'non_refundable');
});

const paid = (id, amount, paidAt, extra = {}) => ({
  id, repKey: 'rep.one', status: 'paid', ticket: amount, collectedAmount: amount,
  soldAt: '2026-10-06T18:00:00Z', saleDate: '2026-10-06', cancelEndsAt: Date.parse('2026-10-10T06:00:00Z'),
  completedAt: paidAt, paidAt, ...extra,
});

test('commission: a $1,600 paid job earns $400 and a cancelled job earns $0', () => {
  const now = Date.parse('2026-11-01T00:00:00Z');
  const [row] = saleCommissions([paid('s1', 1600, '2026-10-20T20:00:00Z')], DEFAULT_SETTINGS.commission, { now });
  assert.equal(row.total, 400);
  const cancelled = { ...paid('s2', 1600, '2026-10-20T20:00:00Z'), status: 'cancelled' };
  assert.deepEqual(saleCommissions([cancelled], DEFAULT_SETTINGS.commission, { now }), []);
});

test('commission is not earned before the job is completed, paid and past the cancellation deadline', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  const early = paid('s1', 1600, '2026-10-08T20:00:00Z');
  assert.deepEqual(saleCommissions([early], DEFAULT_SETTINGS.commission, { now }), [], 'still inside the cancellation window');
  const completedOnly = { ...paid('s2', 1600, '2026-10-20T20:00:00Z'), status: 'completed', paidAt: null };
  assert.deepEqual(saleCommissions([completedOnly], DEFAULT_SETTINGS.commission, { now: Date.parse('2026-11-01T00:00:00Z') }), []);
});

test('accelerator: $10,000 collected in one month earns $2,600', () => {
  assert.equal(monthlyCommission(10000, DEFAULT_SETTINGS.commission), 2600);
  assert.equal(monthlyCommission(10000, { ...DEFAULT_SETTINGS.commission, acceleratorEnabled: false }), 2500);
  // Split across several sales the marginal rate still lands on the revenue above $8,000.
  const now = Date.parse('2026-12-01T00:00:00Z');
  const rows = saleCommissions([
    paid('a', 4000, '2026-10-12T18:00:00Z'), paid('b', 3000, '2026-10-15T18:00:00Z'), paid('c', 3000, '2026-10-28T18:00:00Z'),
  ], DEFAULT_SETTINGS.commission, { now });
  assert.equal(rows.reduce((sum, r) => sum + r.total, 0), 2600);
  assert.deepEqual(rows.map(r => r.total), [1000, 750, 850]);
  // A new month starts below the threshold again.
  const nextMonth = saleCommissions([paid('d', 9000, '2026-10-30T18:00:00Z'), paid('e', 1000, '2026-11-02T18:00:00Z')], DEFAULT_SETTINGS.commission, { now });
  assert.deepEqual(nextMonth.map(r => r.total), [2300, 250]);
});

test('lead override pays 3% of team collected revenue to the lead on the sale, never on the lead\'s own sales', () => {
  const now = Date.parse('2026-12-01T00:00:00Z');
  const overrides = leadOverrides([
    paid('a', 2000, '2026-10-20T18:00:00Z', { leadKey: 'lead.one' }),
    paid('b', 1500, '2026-10-21T18:00:00Z', { repKey: 'lead.one', leadKey: 'lead.one' }),
    paid('c', 1000, '2026-10-22T18:00:00Z'),
  ], DEFAULT_SETTINGS.commission, { now });
  assert.deepEqual(overrides.map(o => [o.leadKey, o.amount]), [['lead.one', 60]]);
});

test('pay periods: biweekly from the anchor Monday, semimonthly and monthly', () => {
  assert.deepEqual(payPeriodFor('2026-10-06', { period: 'biweekly', anchorDate: '2026-10-05' }), { key: '2026-10-05_2026-10-18', start: '2026-10-05', end: '2026-10-18' });
  assert.equal(payPeriodFor('2026-10-04', { period: 'biweekly', anchorDate: '2026-10-05' }).start, '2026-09-21');
  assert.equal(payPeriodFor('2026-10-16', { period: 'semimonthly' }).key, '2026-10-16_2026-10-31');
  assert.equal(payPeriodFor('2026-02-10', { period: 'monthly' }).end, '2026-02-28');
  assert.equal(payPeriodFor('2026-10-11', { period: 'weekly', anchorDate: '2026-10-05' }).end, '2026-10-11');
});

test('a pay period statement shows booked, pending, earned and paid per rep', () => {
  const settings = mergeSettings({});
  const reps = [{ repKey: 'rep.one', displayName: 'Rep One', status: 'active' }];
  const sales = [
    paid('a', 1600, '2026-10-14T18:00:00Z', { soldAt: '2026-10-06T18:00:00Z', saleDate: '2026-10-06' }),
    { id: 'b', repKey: 'rep.one', status: 'booked', ticket: 2000, soldAt: '2026-10-07T18:00:00Z', saleDate: '2026-10-07', cancelEndsAt: Date.parse('2026-10-11T06:00:00Z') },
    { id: 'c', repKey: 'rep.one', status: 'cancelled', ticket: 900, soldAt: '2026-10-07T19:00:00Z', saleDate: '2026-10-07' },
  ];
  const period = payPeriodFor('2026-10-06', settings.payroll);
  const [row] = periodStatement({ sales, reps, settings, period, payouts: [{ repKey: 'rep.one', periodKey: period.key, amount: 150 }], training: [{ repKey: 'rep.one', date: '2026-10-08', minutes: 90 }], now: Date.parse('2026-10-20T00:00:00Z') });
  assert.equal(row.booked, 3600);
  assert.equal(row.salesBooked, 2);
  assert.equal(row.pending, 500);
  assert.equal(row.earned, 400);
  assert.equal(row.paid, 150);
  assert.equal(row.balance, 250);
  assert.equal(row.trainingPay, 22.74);
  const csv = commissionCsv([row], period);
  assert.match(csv, /^period_start,period_end,rep,username/);
  assert.match(csv, /2026-10-05,2026-10-18,Rep One,rep\.one,2,3600\.00,500\.00,400\.00,0\.00,0\.00,150\.00,250\.00/);
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
});

test('gate: Too early under 40 hours, then Go at $100+, Fix at $70-$100, Stop under $70, final after 150 hours', () => {
  const gate = DEFAULT_SETTINGS.gate;
  assert.equal(gateStatus(39.9, 500, gate).status, 'too_early');
  assert.deepEqual([gateStatus(150, 100, gate).status, gateStatus(150, 100, gate).final], ['go', true]);
  assert.equal(gateStatus(150, 99.99, gate).status, 'fix');
  assert.equal(gateStatus(150, 70, gate).status, 'fix');
  assert.equal(gateStatus(150, 69.99, gate).status, 'stop');
  const provisional = gateStatus(80, 120, gate);
  assert.deepEqual([provisional.status, provisional.final], ['go', false]);
  assert.match(provisional.label, /provisional/);
  assert.equal(gateStatus(400, 0, gate).status, 'stop');
});

test('shift clock excludes breaks and auto-ends at the last door after 4 idle hours', () => {
  const shift = {
    startedAt: '2026-10-06T16:00:00Z', lastDoorAt: '2026-10-06T19:00:00Z',
    breaks: [{ startAt: '2026-10-06T18:00:00Z', endAt: '2026-10-06T18:30:00Z' }],
  };
  const live = shiftTiming(shift, Date.parse('2026-10-06T20:00:00Z'));
  assert.equal(live.ended, false);
  assert.equal(live.knockingMs, 3.5 * 3600000);
  const idle = shiftTiming(shift, Date.parse('2026-10-06T23:00:00Z'));
  assert.deepEqual([idle.ended, idle.autoEnded, idle.knockingMs], [true, true, 2.5 * 3600000]);
  const onBreak = shiftTiming({ ...shift, breaks: [...shift.breaks, { startAt: '2026-10-06T19:30:00Z' }] }, Date.parse('2026-10-06T20:00:00Z'));
  assert.equal(onBreak.onBreak, true);
  assert.equal(onBreak.knockingMs, 3 * 3600000);
});

test('scoreboard metrics compare against the plan, and the car-outside look rate is split out', () => {
  const knocks = [
    ...Array(10).fill({ outcome: 'no_answer' }),
    { outcome: 'not_interested', carOutside: true }, { outcome: 'look', carOutside: true },
    { outcome: 'sold', carOutside: false }, { outcome: 'come_back', carOutside: false },
    { outcome: 'skipped_sign' },
  ];
  const counts = countKnocks(knocks);
  assert.deepEqual([counts.doors, counts.answers, counts.looks, counts.sales, counts.skipped], [14, 4, 2, 1, 1]);
  const m = metrics({ ...counts, knockingMs: 3600000, bookedRevenue: 1600 });
  assert.equal(m.doorsPerHour, 14);
  assert.equal(m.revenuePerHour, 1600);
  assert.equal(m.carLookRate, 0.5);
  assert.equal(m.noCarLookRate, 0.5);
  const plan = planComparison(m, DEFAULT_SETTINGS.plan);
  assert.equal(plan.find(p => p.key === 'doorsPerHour').ratio, 1);
  assert.equal(Math.round(DEFAULT_SETTINGS.plan.doorsPerHour * DEFAULT_SETTINGS.plan.answerRate * DEFAULT_SETTINGS.plan.lookRate * DEFAULT_SETTINGS.plan.closeRate * DEFAULT_SETTINGS.plan.averageTicket), DEFAULT_SETTINGS.plan.revenuePerHour);
});

test('day summaries split knocking time across neighborhoods by doors and feed the scoreboard groups', () => {
  const day = daySummary({
    repKey: 'rep.one', date: '2026-10-06', now: Date.parse('2026-10-07T12:00:00Z'),
    shifts: [{ id: 'sh1', startedAt: '2026-10-06T16:00:00Z', endedAt: '2026-10-06T18:00:00Z', breaks: [] }],
    knocks: [
      { shiftId: 'sh1', outcome: 'no_answer', neighborhoodId: 'a' }, { shiftId: 'sh1', outcome: 'look', neighborhoodId: 'a' },
      { shiftId: 'sh1', outcome: 'sold', neighborhoodId: 'b' }, { shiftId: 'sh1', outcome: 'skipped_sign', neighborhoodId: 'b' },
    ],
    sales: [{ ticket: 1800, neighborhoodId: 'b', status: 'booked' }],
  });
  assert.equal(day.knockingMs, 2 * 3600000);
  assert.equal(day.byNeighborhood.a.knockingMs, 2 * 3600000 * 2 / 3);
  assert.equal(day.byNeighborhood.b.bookedRevenue, 1800);
  const rows = scoreboard([day], { groupBy: 'neighborhood', neighborhoods: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Bravo' }] });
  assert.deepEqual(rows.map(r => [r.label, r.metrics.doors, r.metrics.sales]), [['Bravo', 1, 1], ['Alpha', 2, 0]]);
});

test('coverage counts knocked houses, looks, sales and who is there now', () => {
  const now = Date.parse('2026-10-06T20:00:00Z');
  const rows = coverage({
    now,
    neighborhoods: [{ id: 'n1', name: 'Kechter Farm' }],
    houses: [
      { id: 'h1', neighborhoodId: 'n1', street: 'A ST', summary: { lastOutcome: 'look', looks: 1, lastAt: '2026-10-06T19:00:00Z' } },
      { id: 'h2', neighborhoodId: 'n1', street: 'A ST', summary: { lastOutcome: 'sold', looks: 1, sold: true, lastAt: '2026-10-06T19:30:00Z' } },
      { id: 'h3', neighborhoodId: 'n1', street: 'B ST' },
      { id: 'h4', neighborhoodId: 'n1', street: 'B ST', excluded: true },
      { id: 'h5', neighborhoodId: 'n1', street: 'B ST', noKnock: { source: 'city' } },
    ],
    activeShifts: [{ repKey: 'rep.one', lastNeighborhoodId: 'n1', lastStreet: 'A ST', lastDoorAt: '2026-10-06T19:45:00Z' }],
    reps: [{ repKey: 'rep.one', displayName: 'Rep One' }],
  });
  const [n] = rows;
  assert.deepEqual([n.total, n.knocked, n.percent, n.looks, n.sales, n.lastKnockedAt], [3, 2, 66.7, 2, 1, '2026-10-06T19:30:00Z']);
  assert.deepEqual(n.hereNow, ['Rep One']);
  assert.deepEqual(n.streets.map(s => [s.street, s.knocked, s.total, s.hereNow.length]), [['A ST', 2, 2, 1], ['B ST', 0, 1, 0]]);
});

test('settings validate and fall back to defaults when a stored value is out of range', () => {
  assert.deepEqual(validateSettings(DEFAULT_SETTINGS), []);
  assert.equal(mergeSettings({ commission: { rate: 0.3 } }).commission.rate, 0.3);
  assert.equal(mergeSettings({ commission: { rate: 3 } }).commission.rate, 0.25);
  assert.match(validateSettings({ ...structuredClone(DEFAULT_SETTINGS), gate: { ...DEFAULT_SETTINGS.gate, fixPerHour: 120 } }).join(' '), /goPerHour must be above/);
});
