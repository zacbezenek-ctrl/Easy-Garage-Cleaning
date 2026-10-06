import test from 'node:test';
import assert from 'node:assert/strict';
import { knockReportsHandlers } from '../functions/api/knock-reports.js';
import { knockAdminHandlers } from '../functions/api/knock-admin.js';
import { call, cookieFor, get, knockEnv, knockWorld, post, uuid } from './helpers/knock-fixture.mjs';

// Tuesday 2026-10-20 noon in Fort Collins; the biweekly period is 2026-10-19 to 2026-11-01.
const NOW = Date.parse('2026-10-20T18:00:00.000Z');

const sale = (id, repKey, fields) => ({
  repKey, leadKey: repKey === 'rep.one' ? 'lead.one' : '', knockId: uuid(), houseId: `h-${id}`, neighborhoodId: 'english-ranch',
  address: { number: '1', street: 'A ST', unit: '' }, customer: { name: `Customer ${id}`, phone: '+19705550100', email: `${id}@example.com` },
  textConsent: true, package: 'The Works', depositRate: 0.2, statusHistory: [], handoff: {}, ...fields,
});

const day = (repKey, date, hours, fields = {}) => ({
  repKey, date, knockingMs: hours * 3600000, doors: 14 * hours, answers: Math.round(14 * hours * 0.35), looks: 2 * hours, sales: hours >= 4 ? 1 : 0,
  bookedRevenue: hours >= 4 ? 1600 : 0, skipped: 0, afterEnd: 0, car: { answers: 4, looks: 2 }, noCar: { answers: 10, looks: 1 },
  byNeighborhood: { 'english-ranch': { knockingMs: hours * 3600000, doors: 14 * hours, answers: 5, looks: 2, sales: hours >= 4 ? 1 : 0, bookedRevenue: hours >= 4 ? 1600 : 0, skipped: 0, afterEnd: 0, car: { answers: 0, looks: 0 }, noCar: { answers: 0, looks: 0 } } },
  ...fields,
});

function seed() {
  return {
    'knock_neighborhoods/english-ranch': { name: 'English Ranch', tier: 'Volume', status: 'open', cityKey: 'fort-collins' },
    'knock_reps/rep.one': { repKey: 'rep.one', username: 'Rep.One', displayName: 'Rep One', role: 'knocker', status: 'active', permitListed: true, leadKey: 'lead.one' },
    'knock_reps/rep.two': { repKey: 'rep.two', username: 'Rep.Two', displayName: 'Rep Two', role: 'knocker', status: 'active', permitListed: true, leadKey: '' },
    'knock_reps/lead.one': { repKey: 'lead.one', username: 'Lead.One', displayName: 'Lead One', role: 'lead', status: 'active', permitListed: true, leadKey: '' },
    // Earned in this period: sold 10/6, deadline 10/9, completed and paid 10/19.
    'knock_sales/s-earned': sale('s-earned', 'rep.one', { ticket: 1600, depositAmount: 320, status: 'paid', collectedAmount: 1600, soldAt: '2026-10-06T18:00:00.000Z', saleDate: '2026-10-06', cancelDeadlineDate: '2026-10-09', cancelEndsAt: '2026-10-10T06:00:00.000Z', jobDate: '2026-10-19', completedAt: '2026-10-19T20:00:00.000Z', paidAt: '2026-10-19T21:00:00.000Z' }),
    // Booked this period, not earned yet.
    'knock_sales/s-booked': sale('s-booked', 'rep.one', { ticket: 2000, depositAmount: 400, status: 'booked', soldAt: '2026-10-19T19:00:00.000Z', saleDate: '2026-10-19', cancelDeadlineDate: '2026-10-22', cancelEndsAt: '2026-10-23T06:00:00.000Z', jobDate: '2026-10-28' }),
    // Cancelled: pays nothing.
    'knock_sales/s-cancelled': sale('s-cancelled', 'rep.one', { ticket: 900, depositAmount: 180, status: 'cancelled', soldAt: '2026-10-19T20:00:00.000Z', saleDate: '2026-10-19', cancelDeadlineDate: '2026-10-22', cancelEndsAt: '2026-10-23T06:00:00.000Z', jobDate: '2026-10-28', cancelledAt: '2026-10-20T15:00:00.000Z' }),
    'knock_sales/s-two': sale('s-two', 'rep.two', { ticket: 1200, depositAmount: 240, status: 'booked', soldAt: '2026-10-19T19:30:00.000Z', saleDate: '2026-10-19', cancelDeadlineDate: '2026-10-22', cancelEndsAt: '2026-10-23T06:00:00.000Z', jobDate: '2026-10-29' }),
    'knock_training/t1': { repKey: 'rep.one', date: '2026-10-19', minutes: 120, note: 'Ride-along', loggedBy: 'ZacB', at: '2026-10-19T23:00:00.000Z' },
    'knock_days/rep.one_2026-10-19': day('rep.one', '2026-10-19', 5),
    'knock_days/rep.one_2026-10-20': day('rep.one', '2026-10-20', 2),
    'knock_days/rep.two_2026-10-19': day('rep.two', '2026-10-19', 4),
    'knock_days/lead.one_2026-10-19': day('lead.one', '2026-10-19', 3),
  };
}

async function setup() {
  const env = knockEnv();
  const world = knockWorld(seed());
  const now = () => new Date(NOW);
  const reports = knockReportsHandlers({ storage: world.storage, now });
  const admin = knockAdminHandlers({ storage: world.storage, now });
  const cookies = { rep: await cookieFor(env, 'Rep.One'), two: await cookieFor(env, 'Rep.Two'), lead: await cookieFor(env, 'Lead.One'), zac: await cookieFor(env, 'ZacB') };
  const report = (view, cookie, query = '') => call(reports.get, get(`/api/knock-reports?view=${view}${query}`, cookie), env);
  return { env, world, reports, admin, cookies, report };
}

test('a rep sees booked, pending, earned and paid for their own pay periods', async () => {
  const { report, cookies } = await setup();
  const { body } = await report('my-money', cookies.rep);
  const [current] = body.periods;
  assert.equal(current.period.key, '2026-10-19_2026-11-01');
  assert.deepEqual([current.booked, current.salesBooked, current.pending, current.earned, current.paid, current.balance], [2000, 1, 500, 400, 0, 400]);
  assert.equal(current.trainingPay, 30.32);
  const previous = body.periods[1];
  assert.deepEqual([previous.period.key, previous.booked, previous.earned], ['2026-10-05_2026-10-18', 1600, 0]);
  assert.deepEqual(body.sales.map(s => [s.id, s.commission.state, s.commission.amount]), [['s-cancelled', 'cancelled', 0], ['s-booked', 'pending', 500], ['s-earned', 'earned', 400]]);
  assert.equal(JSON.stringify(body).includes('Customer s-two'), false, 'never another rep\'s sales');
});

test('a lead earns the override on the team\'s collected revenue', async () => {
  const { report, cookies } = await setup();
  const { body } = await report('my-money', cookies.lead);
  assert.equal(body.periods[0].override, 48);
  assert.deepEqual(body.overrides.map(o => o.amount), [48]);
  assert.equal(body.sales.length, 0, 'team sales are not listed as the lead\'s own');
});

test('admins see every rep, record a payout once, and export commission, training and sales CSVs', async () => {
  const { admin, cookies, env, report } = await setup();
  const view = await call(admin.get, get('/api/knock-admin?view=money', cookies.zac), env);
  assert.equal(view.body.period.key, '2026-10-19_2026-11-01');
  assert.deepEqual(view.body.statement.map(r => [r.repKey, r.booked, r.earned, r.override]), [['lead.one', 0, 0, 48], ['rep.one', 2000, 400, 0], ['rep.two', 1200, 0, 0]]);
  const requestId = uuid();
  const payout = { action: 'payout.add', requestId, repKey: 'rep.one', periodKey: '2026-10-19_2026-11-01', amount: 400, note: 'Check 1001' };
  assert.equal((await call(admin.post, post('/api/knock-admin', payout, cookies.zac), env)).body.duplicate, false);
  assert.equal((await call(admin.post, post('/api/knock-admin', payout, cookies.zac), env)).body.duplicate, true);
  const after = await call(admin.get, get('/api/knock-admin?view=money', cookies.zac), env);
  assert.deepEqual(after.body.statement.find(r => r.repKey === 'rep.one').balance, 0);
  assert.equal((await report('my-money', cookies.rep)).body.periods[0].paid, 400);

  const csv = await admin.get({ request: get('/api/knock-admin?view=export&kind=commission&date=2026-10-20', cookies.zac), env });
  assert.equal(csv.headers.get('Content-Type'), 'text/csv; charset=utf-8');
  assert.match(csv.headers.get('Content-Disposition'), /egc-knock-commission-2026-10-19-2026-11-01\.csv/);
  const text = await csv.text();
  assert.match(text, /^period_start,period_end,rep,username,sales_booked,booked_revenue,pending_commission,earned_commission,accelerator_included,lead_override,paid,balance_due\r\n/);
  assert.match(text, /2026-10-19,2026-11-01,Rep One,rep\.one,1,2000\.00,500\.00,400\.00,0\.00,0\.00,400\.00,0\.00/);
  const training = await (await admin.get({ request: get('/api/knock-admin?view=export&kind=training&date=2026-10-20', cookies.zac), env })).text();
  assert.match(training, /2026-10-19,Rep One,rep\.one,120,2\.00,15\.16,30\.32,Ride-along/);
  const sales = await (await admin.get({ request: get('/api/knock-admin?view=export&kind=sales&date=2026-10-20', cookies.zac), env })).text();
  assert.equal(sales.split('\r\n').filter(Boolean).length, 4, 'header plus the three sales sold this period');
  assert.equal(sales.includes('@example.com'), false, 'the payroll sales export carries no customer contact details');
  assert.equal((await call(admin.get, get('/api/knock-admin?view=export&kind=commission', cookies.rep), env)).status, 403, 'only admins export');
});

test('the scoreboard is scoped: a rep sees themselves, a lead the team, an admin everyone with the gate', async () => {
  const { report, cookies } = await setup();
  const mine = (await report('scoreboard', cookies.rep, '&range=week')).body;
  assert.equal(mine.scope, 'self');
  assert.deepEqual(mine.rows.map(r => r.key), ['rep.one']);
  assert.equal(mine.gate, undefined);
  const team = (await report('scoreboard', cookies.lead, '&range=week')).body;
  assert.deepEqual(team.rows.map(r => r.key).sort(), ['lead.one', 'rep.one']);
  const all = (await report('scoreboard', cookies.zac, '&range=week')).body;
  assert.deepEqual(all.rows.map(r => r.key).sort(), ['lead.one', 'rep.one', 'rep.two']);
  assert.deepEqual([all.gate.hours, all.gate.status, all.gate.final], [14, 'too_early', false]);
  const rate = all.totals.metrics;
  assert.equal(rate.knockingHours, 14);
  assert.equal(rate.doors, 196);
  assert.equal(Math.round(rate.revenuePerHour * 100) / 100, Math.round(3200 / 14 * 100) / 100);
  assert.ok(all.totals.plan.find(p => p.key === 'revenuePerHour').ratio > 1);
  assert.deepEqual([all.car.withCar, Math.round(all.car.withoutCar * 1000) / 1000], [0.5, 0.1]);
  const byDay = (await report('scoreboard', cookies.zac, '&range=week&groupBy=day')).body;
  assert.deepEqual(byDay.rows.map(r => r.key), ['2026-10-20', '2026-10-19']);
  const byNbhd = (await report('scoreboard', cookies.zac, '&range=week&groupBy=neighborhood')).body;
  assert.deepEqual(byNbhd.rows.map(r => r.label), ['English Ranch']);
  const today = (await report('scoreboard', cookies.zac, '&range=today')).body;
  assert.deepEqual(today.rows.map(r => r.key), ['rep.one']);
});
