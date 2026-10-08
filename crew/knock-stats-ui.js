/* Money and scoreboard screens. Reps: their pay periods and their own numbers against the plan.
   Leads: their team's scoreboard. Admins get the same scoreboard for everyone plus the gate,
   and the payroll screens live in knock-admin.js. */
import { h, mount, money, percent, number, hoursLabel, dateLabel, icon, dot, badge, banner, kv, stat, meter, seg, chips, emptyState, loadingState, errorState } from './knock-ui.js';
import { collectedAmount } from './knock-money.js';
import { zonedDate } from './knock-time.js';

let app;

export const METRIC_LABELS = {
  doorsPerHour: ['Doors per hour', v => number(v, 1)],
  answerRate: ['Answer rate', v => percent(v)],
  lookRate: ['Look rate', v => percent(v, 1)],
  closeRate: ['Close rate', v => percent(v)],
  averageTicket: ['Average ticket', v => money(v)],
  revenuePerHour: ['Booked $ per hour', v => money(v)],
};

const RANGES = [['today', 'Today'], ['week', '7 days'], ['month', 'Month'], ['season', 'Season'], ['all', 'All time']];
const GROUPS = [['rep', 'By rep'], ['team', 'By team'], ['neighborhood', 'By neighborhood'], ['day', 'By day']];
const RANGE_WORDS = { today: 'today', week: 'this week', month: 'this month', season: 'this season', all: 'all time' };

const toneFor = ratio => (ratio == null ? '' : ratio >= 1 ? 'success' : ratio >= 0.8 ? '' : 'warning');

export function planMeters(plan) {
  return plan.filter(row => row.key !== 'revenuePerHour').map(row => {
    const [label, fmt] = METRIC_LABELS[row.key];
    return meter({ label, value: h('span', {}, row.actual == null ? '—' : fmt(row.actual), h('span', { class: 'muted' }, ` / ${fmt(row.plan)}`)), ratio: row.ratio ?? 0, tone: toneFor(row.ratio) });
  });
}

function headline(metrics, plan, rangeKey) {
  const target = plan.find(row => row.key === 'revenuePerHour');
  return h('section', { class: 'card', style: { gap: '6px', alignItems: 'flex-start' } },
    h('span', { class: 'stat__label' }, `Dollars booked per hour · ${RANGE_WORDS[rangeKey] || ''}`),
    h('div', { class: 'row', style: { alignItems: 'baseline', gap: '10px' } },
      h('span', { class: 'num num--xl' }, metrics.revenuePerHour == null ? '—' : money(metrics.revenuePerHour)),
      target ? h('span', { class: 'muted bold' }, `plan ${money(target.plan)}`) : null),
    h('div', { style: { width: '100%' } }, meter({ ratio: target?.ratio ?? 0, tone: 'orange', goal: 1,
      note: `${number(metrics.knockingHours, 1)} h on the clock · ${money(metrics.bookedRevenue)} booked` })));
}

export function gateCard(gate) {
  if (!gate) return null;
  const t = gate.thresholds;
  const max = Math.max(t.goPerHour * 1.5, (gate.revenuePerHour || 0) * 1.1);
  const position = Math.max(2, Math.min(98, ((gate.revenuePerHour || 0) / max) * 100));
  const tone = { go: 'success', fix: 'warning', stop: 'error', too_early: 'info' }[gate.status] || 'info';
  return h('section', { class: 'card', style: { gap: '10px' } },
    h('div', { class: 'row row--between' }, h('h2', {}, 'Go / Fix / Stop'), badge(`${number(gate.hours, 0)} of ${t.decisionHours} h`, tone)),
    h('p', { class: 'caption muted' }, `${gate.label}. Too early under ${t.minimumHours} hours; the call is made at ${t.decisionHours} hours on dollars booked per knocking hour.`),
    h('div', { class: 'gate', style: { gridTemplateColumns: `${t.fixPerHour}fr ${t.goPerHour - t.fixPerHour}fr ${max - t.goPerHour}fr` } },
      h('div', { style: { background: 'var(--error)', borderRadius: '6px 0 0 6px' } }, `Stop · under ${money(t.fixPerHour)}`),
      h('div', { style: { background: 'var(--warning)' } }, 'Fix'),
      h('div', { style: { background: 'var(--success)', borderRadius: '0 6px 6px 0' } }, `Go · ${money(t.goPerHour)}+`)),
    gate.revenuePerHour == null ? null : h('div', { class: 'gate__marker' },
      h('div', { style: { left: `${position}%` } }, h('i', {}), h('span', { class: 'caption bold' }, `So far · ${money(gate.revenuePerHour)}/h`))));
}

export function carCard(car) {
  const top = Math.max(car.withCar || 0, car.withoutCar || 0, 0.01);
  return h('section', { class: 'card', style: { gap: '10px' } },
    h('h2', {}, 'Look rate · car outside vs not'),
    meter({ label: h('span', { class: 'row', style: { gap: '6px' } }, icon('car', { size: 'sm' }), 'Car outside'), value: percent(car.withCar, 1), ratio: (car.withCar || 0) / top, tone: 'orange' }),
    meter({ label: 'No car', value: percent(car.withoutCar, 1), ratio: (car.withoutCar || 0) / top }),
    h('p', { class: 'caption muted' }, `Based on ${car.answersWithCar + car.answersWithoutCar} answered doors (${car.answersWithCar} with a car outside).`));
}

function dayBars(rows, planPerHour) {
  const days = rows.filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.key)).sort((a, b) => a.key.localeCompare(b.key)).slice(-7);
  if (!days.length) return null;
  const top = Math.max(planPerHour || 0, ...days.map(d => d.metrics.revenuePerHour || 0), 1);
  return h('section', { class: 'card', style: { gap: '8px' } },
    h('div', { class: 'row row--between' }, h('h2', {}, '$ booked per hour · by day'), planPerHour ? h('span', { class: 'caption muted' }, `plan ${money(planPerHour)}`) : null),
    h('div', { class: 'bars', role: 'img', 'aria-label': `Dollars per hour by day: ${days.map(d => `${dateLabel(d.key)} ${d.metrics.revenuePerHour == null ? 'none' : money(d.metrics.revenuePerHour)}`).join(', ')}` },
      days.map(d => {
        const value = d.metrics.revenuePerHour;
        return h('div', { class: 'bar' }, h('span', {}, value == null ? '–' : money(value)),
          h('div', { class: `bar__fill${value != null && planPerHour && value >= planPerHour ? ' bar__fill--orange' : ''}`, style: { height: value == null ? '2px' : `${Math.max(2, value / top * 70)}%`, opacity: value == null ? '.3' : null } }),
          h('span', {}, new Date(`${d.key}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })));
      })));
}

function groupTable(data) {
  if (!(data.rows.length > 1 || data.scope !== 'self')) return null;
  return h('section', { class: 'stack' },
    h('h2', { style: { fontSize: '18px' } }, GROUPS.find(([key]) => key === data.groupBy)?.[1] || 'Breakdown'),
    h('div', { class: 'card card--line table-wrap' }, h('table', { class: 'table' },
      h('thead', {}, h('tr', {}, ['', 'Hours', 'Doors', 'Answers', 'Looks', 'Sales', 'Booked', '$ / h'].map((label, i) => h('th', { class: i ? 'num' : '' }, label)))),
      h('tbody', {}, data.rows.map(row => h('tr', {},
        h('td', {}, h('b', {}, data.groupBy === 'day' ? dateLabel(row.label) : row.label)), h('td', { class: 'num' }, number(row.metrics.knockingHours, 1)), h('td', { class: 'num' }, String(row.metrics.doors)),
        h('td', { class: 'num' }, String(row.metrics.answers)), h('td', { class: 'num' }, String(row.metrics.looks)), h('td', { class: 'num' }, String(row.metrics.sales)),
        h('td', { class: 'num' }, money(row.metrics.bookedRevenue)), h('td', { class: 'num' }, row.metrics.revenuePerHour == null ? '—' : money(row.metrics.revenuePerHour))))))));
}

// The scoreboard body for the admin screen: every range and grouping, the gate and the table.
export function scoreboardBody(data, { onRange, onGroup }) {
  const m = data.totals.metrics;
  return h('div', { class: 'stack', style: { gap: '20px' } },
    chips(RANGES, data.range.preset, onRange, { label: 'Range' }),
    chips(GROUPS, data.groupBy, onGroup, { label: 'Group by' }),
    h('p', { class: 'caption muted' }, `${dateLabel(data.range.from)} to ${dateLabel(data.range.to)} · ${data.scope === 'all' ? 'Team total' : data.scope === 'team' ? 'Your team' : 'You'}`),
    h('div', { class: 'cols' },
      h('div', { class: 'stack', style: { gap: '16px' } },
        headline(m, data.totals.plan, data.range.preset),
        gateCard(data.gate)),
      h('section', { class: 'stack stack--tight' },
        h('h2', { style: { fontSize: '18px' } }, 'Against the plan'), planMeters(data.totals.plan),
        h('div', { class: 'stats stats--3', style: { marginTop: '6px' } },
          stat('Doors', String(m.doors), { small: true }), stat('Answers', String(m.answers), { small: true }), stat('Looks · Sales', `${m.looks} · ${m.sales}`, { small: true })),
        carCard(data.car))),
    groupTable(data));
}

function statsScreen(_app, params) {
  const rangeKey = params.get('range') === 'week' ? 'week' : 'today';
  const box = h('div', { class: 'screen' }, seg([['today', 'Today'], ['week', 'This week']], rangeKey, key => app.go('stats', { range: key }), { label: 'Period' }), loadingState(4));
  const load = () => app.api(`/api/knock-reports?view=scoreboard&range=${rangeKey}&groupBy=day`).then(data => {
    const m = data.totals.metrics;
    mount(box,
      seg([['today', 'Today'], ['week', 'This week']], rangeKey, key => app.go('stats', { range: key }), { label: 'Period' }),
      m.doors ? null : banner('info', 'info', 'No doors yet', rangeKey === 'today' ? 'Your numbers fill in as you knock today.' : 'Your numbers fill in as you knock.'),
      headline(m, data.totals.plan, rangeKey),
      h('section', { class: 'stack stack--tight' },
        h('h2', { style: { fontSize: '18px' } }, 'Against the plan'), planMeters(data.totals.plan),
        h('div', { class: 'stats stats--3', style: { marginTop: '6px' } },
          stat('Doors', String(m.doors), { small: true }), stat('Answers', String(m.answers), { small: true }), stat('Looks · Sales', `${m.looks} · ${m.sales}`, { small: true }))),
      gateCard(data.gate),
      carCard(data.car),
      rangeKey === 'week' ? dayBars(data.rows, data.planTargets?.revenuePerHour) : null);
  }, error => mount(box, seg([['today', 'Today'], ['week', 'This week']], rangeKey, key => app.go('stats', { range: key })), errorState(error, () => app.render())));
  load();
  return box;
}

const COMMISSION_BADGE = { earned: ['Earned', 'success'], pending: ['Pending', 'warning'], cancelled: ['Cancelled', 'error'] };

// "Oct 5 – 18", or "Sep 28 – Oct 11" across a month.
export function periodLabel(start, end) {
  const md = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return start.slice(0, 7) === end.slice(0, 7) ? `${md(start)} – ${Number(end.slice(8, 10))}` : `${md(start)} – ${md(end)}`;
}

function moneyScreen(_app, params) {
  const showPast = params.get('past') === '1';
  const box = h('div', { class: 'screen' }, loadingState(4));
  app.api('/api/knock-reports?view=my-money').then(data => {
    const [current, ...older] = data.periods;
    const rates = data.rates;
    const thisMonth = zonedDate(Date.now()).slice(0, 7);
    const collectedThisMonth = data.sales.filter(s => s.status === 'paid' && s.paidAt && zonedDate(s.paidAt).slice(0, 7) === thisMonth).reduce((sum, s) => sum + collectedAmount(s), 0);
    const inPeriod = data.sales.filter(s => s.saleDate >= current.period.start && s.saleDate <= current.period.end
      || (s.paidAt && zonedDate(s.paidAt) >= current.period.start && zonedDate(s.paidAt) <= current.period.end));
    const lead = app.S.rep.role === 'lead';
    mount(box,
      h('div', { class: 'row row--between row--top' },
        h('div', {}, h('h1', { style: { fontSize: '22px' } }, `Pay period ${periodLabel(current.period.start, current.period.end)}`),
          h('p', { class: 'caption muted' }, `Balance due ${money(current.balance, true)}`)),
        older.length ? h('button', { type: 'button', class: 'btn btn--quiet btn--sm', 'aria-expanded': String(showPast), onclick: () => app.go('money', showPast ? {} : { past: '1' }) },
          'Past periods', icon(showPast ? 'chevronRight' : 'chevronDown', { size: 'sm' })) : null),
      showPast ? h('div', { class: 'card card--line table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ['Period', 'Booked', 'Pending', 'Earned', 'Paid'].map((label, i) => h('th', { class: i ? 'num' : '' }, label)))),
        h('tbody', {}, older.map(p => h('tr', {}, h('td', {}, periodLabel(p.period.start, p.period.end)),
          h('td', { class: 'num' }, money(p.booked)), h('td', { class: 'num' }, money(p.pending)), h('td', { class: 'num' }, money(p.earned + p.override)), h('td', { class: 'num' }, money(p.paid))))))) : null,
      h('div', { class: 'stats' },
        stat('Booked', money(current.booked), { sub: `${current.salesBooked} sale${current.salesBooked === 1 ? '' : 's'} this period` }),
        stat('Pending', money(current.pending), { sub: 'not earned yet' }),
        stat('Earned', money(current.earned + current.override), { sub: current.override ? `includes ${money(current.override, true)} lead bonus` : 'ready to pay', tone: 'success' }),
        stat('Paid', money(current.paid), { sub: 'this period' })),
      h('section', { class: 'card', style: { gap: '10px' } },
        h('h2', {}, 'How commission works'),
        h('p', {}, 'You earn ', h('b', {}, percent(rates.rate)), ' of a sale once the job is ', h('b', {}, 'completed'), ', ', h('b', {}, 'paid'), ', and past its ', h('b', {}, 'cancellation deadline'), '. A cancelled job pays nothing.'),
        rates.acceleratorEnabled ? meter({
          label: `${percent(rates.acceleratorRate)} rate above ${money(rates.acceleratorThreshold)} this month`, value: `${money(collectedThisMonth)} / ${money(rates.acceleratorThreshold)}`,
          ratio: collectedThisMonth / rates.acceleratorThreshold, tone: 'orange', goal: 1,
          note: collectedThisMonth >= rates.acceleratorThreshold ? `You're past the line: collected sales this month pay ${percent(rates.acceleratorRate)} on the amount above it.`
            : `${money(rates.acceleratorThreshold - collectedThisMonth)} more collected this month and every dollar after that pays ${percent(rates.acceleratorRate)}.`,
        }) : null),
      lead && rates.leadOverrideEnabled ? h('section', { class: 'card', style: { gap: '8px' } },
        h('div', { class: 'row row--between' }, h('h2', {}, `Lead bonus · ${percent(rates.leadOverrideRate, 1)} of your team`), badge('Lead', 'navy')),
        kv('Earned this period', money(current.override, true)),
        kv('Earned so far', money((data.overrides || []).reduce((sum, o) => sum + o.amount, 0), true))) : null,
      h('section', { class: 'card', style: { gap: '8px' } },
        h('div', { class: 'row row--between' }, h('h2', {}, 'Training hours'), badge('Paid by the hour')),
        kv('This period', `${hoursLabel((current.trainingMinutes || 0) * 60000)} h`),
        kv('Pay', `${money(current.trainingPay, true)} at ${money(data.trainingHourlyRate, true)}/h`)),
      h('section', { class: 'stack stack--tight' },
        h('h2', { style: { fontSize: '18px' } }, 'This period\'s sales'),
        inPeriod.length ? h('div', { class: 'list list--boxed' }, inPeriod.map(s => {
          const [label, tone] = s.status === 'booked' && s.commission.state === 'pending' ? ['Booked', 'info'] : (COMMISSION_BADGE[s.commission.state] || [s.commission.state, '']);
          const sub = s.status === 'paid' ? `Paid${s.paidAt ? ` ${dateLabel(zonedDate(s.paidAt))}` : ''} · ${money(s.commission.amount, true)} ${s.commission.state === 'earned' ? 'earned' : 'after the deadline'}`
            : s.status === 'completed' ? `Completed${s.completedAt ? ` ${dateLabel(zonedDate(s.completedAt))}` : ''} · not paid yet`
            : s.status === 'cancelled' ? 'Cancelled · no commission' : `Job ${dateLabel(s.jobDate)} · refund window to ${dateLabel(s.cancelDeadlineDate)}`;
          return h('div', { class: 'list-row list-row--static' }, dot('sold', { large: true }),
            h('span', { class: 'list-row__main' }, h('span', { class: 'list-row__title' }, `${s.address.number} ${s.address.street.split(' ').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ')} · ${money(s.ticket)}`), h('span', { class: 'list-row__sub' }, sub)),
            badge(label, tone));
        })) : emptyState('dollar', 'No sales this period', 'Sales you book show up here with what they pay you.')));
  }, error => mount(box, errorState(error, () => app.render())));
  return box;
}

export function install(appApi) {
  app = appApi;
  app.registerScreen('stats', statsScreen, { title: 'Scoreboard', back: 'more' });
  app.registerScreen('money', moneyScreen, { title: 'My money', back: 'more' });
  app.moreLinks.push(
    { route: 'money', label: 'My money', icon: 'cash', order: 30, hint: 'Booked, pending, earned and paid' },
    { route: 'stats', label: 'Scoreboard', icon: 'chart', order: 40, hint: 'Your numbers against the plan' });
}
