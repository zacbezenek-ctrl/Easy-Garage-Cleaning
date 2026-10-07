/* Money and scoreboard screens. Reps: their pay periods and their own numbers against the plan.
   Leads: their team's scoreboard. Admins get the same scoreboard for everyone plus the gate,
   and the payroll screens live in knock-admin.js. */
import { h, mount, money, percent, number, hoursLabel, dateLabel } from './knock-ui.js';

let app;

export const METRIC_LABELS = {
  doorsPerHour: ['Doors / hour', v => number(v, 1)],
  answerRate: ['Answer rate', v => percent(v)],
  lookRate: ['Look rate', v => percent(v, 1)],
  closeRate: ['Close rate', v => percent(v)],
  averageTicket: ['Average ticket', v => money(v)],
  revenuePerHour: ['Booked $ / hour', v => money(v)],
};

const RANGES = [['today', 'Today'], ['week', '7 days'], ['month', 'Month'], ['season', 'Season'], ['all', 'All time']];
const GROUPS = [['rep', 'Rep'], ['team', 'Team'], ['neighborhood', 'Neighborhood'], ['day', 'Day']];

export function planTable(plan) {
  return h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, h('th', {}, 'vs plan'), h('th', { class: 'num' }, 'Actual'), h('th', { class: 'num' }, 'Plan'), h('th', { class: 'num' }, '%'))),
    h('tbody', {}, plan.map(row => {
      const [label, fmt] = METRIC_LABELS[row.key];
      const ratio = row.ratio == null ? null : row.ratio;
      return h('tr', {},
        h('td', {}, label), h('td', { class: 'num' }, row.actual == null ? '—' : fmt(row.actual)), h('td', { class: 'num' }, fmt(row.plan)),
        h('td', { class: 'num', style: { color: ratio == null ? '' : ratio >= 1 ? 'var(--ok)' : ratio >= 0.8 ? 'var(--warn)' : 'var(--bad)', fontWeight: '700' } }, ratio == null ? '—' : `${Math.round(ratio * 100)}%`));
    })));
}

export function statTiles(m) {
  return h('div', { class: 'stats' },
    [['Knocking', hoursLabel(m.knockingHours * 3600000)], ['Doors', m.doors], ['Answers', m.answers], ['Looks', m.looks], ['Sales', m.sales], ['Booked', money(m.bookedRevenue)]]
      .map(([label, value]) => h('div', { class: 'stat' }, h('b', {}, String(value)), h('span', {}, label))));
}

export function gateCard(gate) {
  if (!gate) return null;
  const tone = { go: 'ok', fix: 'warn', stop: 'locked', too_early: '' }[gate.status];
  return h('section', { class: 'card accent' },
    h('div', { class: 'row spread' }, h('h2', {}, 'The gate'), h('span', { class: `badge ${tone}` }, gate.label)),
    h('p', {}, `${number(gate.hours, 1)} knocking hours so far at ${gate.revenuePerHour == null ? '—' : money(gate.revenuePerHour)} booked per knocking hour.`),
    h('p', { class: 'muted' }, `Under ${gate.thresholds.minimumHours} hours it is too early. After ${gate.thresholds.decisionHours} hours: ${money(gate.thresholds.goPerHour)}+ is Go, ${money(gate.thresholds.fixPerHour)} to ${money(gate.thresholds.goPerHour)} is Fix, under ${money(gate.thresholds.fixPerHour)} is Stop.`));
}

export function carCard(car) {
  return h('section', { class: 'card' },
    h('h3', {}, 'Car parked outside the garage'),
    h('p', {}, `Look rate with a car outside: ${percent(car.withCar, 1)} (${car.answersWithCar} answers). Without: ${percent(car.withoutCar, 1)} (${car.answersWithoutCar} answers).`));
}

export function scoreboardBody(data, { onRange, onGroup, showGroups = true }) {
  return h('div', {},
    h('div', { class: 'filters' }, RANGES.map(([key, label]) => h('button', { type: 'button', 'aria-pressed': String(data.range.preset === key), onclick: () => onRange(key) }, label))),
    showGroups ? h('div', { class: 'filters' }, GROUPS.map(([key, label]) => h('button', { type: 'button', 'aria-pressed': String(data.groupBy === key), onclick: () => onGroup(key) }, label))) : null,
    h('p', { class: 'muted' }, `${dateLabel(data.range.from)} to ${dateLabel(data.range.to)}`),
    gateCard(data.gate),
    h('section', { class: 'card' }, h('h2', {}, data.scope === 'self' ? 'You' : data.scope === 'team' ? 'Your team' : 'Team total'), statTiles(data.totals.metrics), h('div', { class: 'scroll-x', style: { marginTop: '.6rem' } }, planTable(data.totals.plan))),
    carCard(data.car),
    data.rows.length > 1 || data.scope !== 'self' ? h('section', { class: 'card' },
      h('h2', {}, `By ${data.groupBy}`),
      h('div', { class: 'scroll-x' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, ['', 'Hours', 'Doors', 'Answers', 'Looks', 'Sales', 'Booked', '$ / hr'].map((label, i) => h('th', { class: i ? 'num' : '' }, label)))),
        h('tbody', {}, data.rows.map(row => h('tr', {},
          h('td', {}, row.label), h('td', { class: 'num' }, number(row.metrics.knockingHours, 1)), h('td', { class: 'num' }, String(row.metrics.doors)),
          h('td', { class: 'num' }, String(row.metrics.answers)), h('td', { class: 'num' }, String(row.metrics.looks)), h('td', { class: 'num' }, String(row.metrics.sales)),
          h('td', { class: 'num' }, money(row.metrics.bookedRevenue)), h('td', { class: 'num' }, row.metrics.revenuePerHour == null ? '—' : money(row.metrics.revenuePerHour)))))))) : null);
}

function statsScreen(_app, params) {
  const rangeKey = params.get('range') || 'week';
  const groupBy = params.get('groupBy') || (app.S.rep.role === 'lead' ? 'rep' : 'day');
  const box = h('div', {}, h('h1', {}, 'Scoreboard'), h('p', { class: 'loading' }, 'Loading…'));
  app.api(`/api/knock-reports?view=scoreboard&range=${encodeURIComponent(rangeKey)}&groupBy=${encodeURIComponent(groupBy)}`).then(data => {
    mount(box, h('h1', {}, 'Scoreboard'), scoreboardBody(data, {
      onRange: key => app.go('stats', { range: key, groupBy }),
      onGroup: key => app.go('stats', { range: rangeKey, groupBy: key }),
    }));
  }, error => mount(box, h('h1', {}, 'Scoreboard'), h('p', { class: 'notice error' }, error.status === 0 ? 'Connect to see the scoreboard. Your doors are saved on this phone.' : error.message)));
  return box;
}

function moneyScreen() {
  const box = h('div', {}, h('h1', {}, 'My money'), h('p', { class: 'loading' }, 'Loading…'));
  app.api('/api/knock-reports?view=my-money').then(data => {
    const [current, ...older] = data.periods;
    const row = p => [['Booked', money(p.booked)], ['Pending', money(p.pending)], ['Earned', money(p.earned + p.override)], ['Paid', money(p.paid)]];
    mount(box, h('h1', {}, 'My money'),
      h('section', { class: 'card accent' },
        h('span', { class: 'eyebrow' }, `This pay period · ${dateLabel(current.period.start)} to ${dateLabel(current.period.end)}`),
        h('div', { class: 'stats' }, row(current).map(([label, value]) => h('div', { class: 'stat' }, h('b', {}, value), h('span', {}, label)))),
        h('p', {}, `Balance due: `, h('b', {}, money(current.balance, true))),
        current.override ? h('p', { class: 'muted' }, `Includes ${money(current.override, true)} lead override.`) : null,
        current.trainingMinutes ? h('p', { class: 'muted' }, `Training: ${hoursLabel(current.trainingMinutes * 60000)} h, ${money(current.trainingPay, true)} at ${money(data.trainingHourlyRate, true)}/h (paid separately).`) : null),
      h('p', { class: 'muted' }, `Commission is ${Math.round(data.rates.rate * 100)}% of collected revenue, earned when the job is completed, paid and past the cancellation deadline.${data.rates.acceleratorEnabled ? ` ${Math.round(data.rates.acceleratorRate * 100)}% on collected revenue above ${money(data.rates.acceleratorThreshold)} in a month.` : ''} A cancelled job pays nothing.`),
      h('section', { class: 'card' }, h('h2', {}, 'By sale'),
        data.sales.length ? h('ul', { class: 'list' }, data.sales.map(s => h('li', {},
          h('span', { style: { flex: '1' } }, h('b', {}, `${s.address.number} ${s.address.street}`), h('br', {}), h('span', { class: 'muted' }, `${dateLabel(s.saleDate)} · ${s.package} · ${money(s.ticket)} · ${s.status}`)),
          h('span', { class: `badge ${s.commission.state === 'earned' ? 'ok' : s.commission.state === 'cancelled' ? 'locked' : 'warn'}` }, `${s.commission.state} ${money(s.commission.amount, true)}`))))
          : h('p', { class: 'muted' }, 'No sales yet.')),
      h('section', { class: 'card' }, h('h2', {}, 'Earlier pay periods'),
        h('div', { class: 'scroll-x' }, h('table', { class: 'data' },
          h('thead', {}, h('tr', {}, ['Period', 'Booked', 'Pending', 'Earned', 'Paid'].map((label, i) => h('th', { class: i ? 'num' : '' }, label)))),
          h('tbody', {}, older.map(p => h('tr', {}, h('td', {}, `${dateLabel(p.period.start)}–${dateLabel(p.period.end)}`), ...row(p).map(([, value]) => h('td', { class: 'num' }, value)))))))));
  }, error => mount(box, h('h1', {}, 'My money'), h('p', { class: 'notice error' }, error.status === 0 ? 'Connect to see your money.' : error.message)));
  return box;
}

export function install(appApi) {
  app = appApi;
  app.registerScreen('stats', statsScreen);
  app.registerScreen('money', moneyScreen);
  app.moreLinks = [...(app.moreLinks || []), ['money', 'My money', 'Booked, pending, earned and paid'], ['stats', 'Scoreboard', 'Doors, looks and sales against the plan']];
}
