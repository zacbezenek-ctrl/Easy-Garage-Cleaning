/* The sale form (opened by the Sold button) and the rep's own sales list.
   Nothing is logged until every checklist item is ticked and the job date is after the
   cancellation deadline; the door and the sale then queue together. */
import { h, mount, money, toast, dateLabel, longDateLabel, timeLabel, icon, dot, badge, banner, kv, stat, seg, choiceGroup, emptyState, loadingState, errorState, fullScreen } from './knock-ui.js';
import { PACKAGES } from './knock-settings.js';
import { cancellationWindow, depositAmount } from './knock-sale-rules.js';
import { addDays, zonedDate } from './knock-time.js';
import { houseLabel } from './knock-doors.js';

let app;

export const normalizePhone = value => {
  const digits = String(value || '').replace(/[^\d]/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : '';
};
const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

function saleForm(house, onSave) {
  const settings = app.S.settings;
  const today = zonedDate(Date.now());
  const window = cancellationWindow(today, { businessDays: settings.sale.cancelBusinessDays, extraHolidays: settings.sale.extraHolidays });
  const quoted = app.houseView(house.id)?.summary?.quotedAmount;
  const checklist = settings.sale.checklist || [];
  return fullScreen('New sale', houseLabel(house), close => {
    const state = { checklist: {} };
    const field = (id, label, input, hint = null) => h('div', { class: 'field' }, h('label', { class: 'label', for: id }, label), input, hint);
    const name = h('input', { class: 'input', id: 'sale-name', autocomplete: 'off', autocapitalize: 'words', required: true });
    const phone = h('input', { class: 'input', id: 'sale-phone', type: 'tel', inputmode: 'tel', autocomplete: 'off', placeholder: '(970) 555-0100', required: true });
    const email = h('input', { class: 'input', id: 'sale-email', type: 'email', inputmode: 'email', autocomplete: 'off', autocapitalize: 'none', required: true });
    const consent = h('input', { type: 'checkbox', id: 'sale-consent' });
    const pkg = choiceGroup(PACKAGES.map(p => [p, p]), '', () => validate());
    const ticket = h('input', { class: 'input input--money', id: 'sale-ticket', type: 'text', inputmode: 'decimal', autocomplete: 'off', value: quoted ? String(quoted) : '', required: true });
    const deposit = h('b', { class: 'serif', style: { fontSize: '22px' } }, '—');
    const due = h('b', {}, '—');
    const jobDate = h('input', { class: 'input', id: 'sale-job-date', type: 'date', min: window.earliestJobDate, value: window.earliestJobDate, required: true });
    const jobTime = h('input', { class: 'input', id: 'sale-job-time', type: 'time', value: settings.sale.defaultJobStartTime });
    const dateError = h('span', { class: 'error-text', hidden: true }, icon('alert', { size: 'sm' }), `Pick a day on or after ${longDateLabel(window.earliestJobDate)}.`);
    const count = h('span', { class: 'badge' }, `0 of ${checklist.length}`);
    const save = h('button', { type: 'submit', class: 'btn btn--success btn--xl btn--block', disabled: true }, 'Save sale');
    const missing = h('p', { class: 'caption muted center' });
    const checks = checklist.map(item => h('label', { class: 'check' },
      h('input', { type: 'checkbox', onchange: event => { state.checklist[item.key] = event.target.checked; validate(); } }), item.label));
    const amount = () => Number(String(ticket.value).replace(/[$,\s]/g, ''));

    function problemsNow() {
      const out = [];
      if (!name.value.trim()) out.push('the customer\'s name');
      if (!normalizePhone(phone.value)) out.push('a 10-digit phone');
      if (!EMAIL.test(email.value.trim())) out.push('an email for the contract');
      if (!pkg.value()) out.push('a package');
      if (!(amount() > 0)) out.push('the price');
      if (!jobDate.value || jobDate.value < window.earliestJobDate) out.push(`a job date on or after ${dateLabel(window.earliestJobDate)}`);
      return out;
    }
    function validate() {
      const value = amount();
      const depositValue = value > 0 ? depositAmount(value, settings.sale.depositRate) : null;
      deposit.textContent = depositValue == null ? '—' : money(depositValue, depositValue % 1 !== 0);
      due.textContent = depositValue == null ? '—' : money(value - depositValue, (value - depositValue) % 1 !== 0);
      dateError.hidden = !jobDate.value || jobDate.value >= window.earliestJobDate;
      jobDate.classList.toggle('input--error', !dateError.hidden);
      const ticked = checklist.filter(item => state.checklist[item.key]).length;
      count.textContent = `${ticked} of ${checklist.length}`;
      count.className = `badge${ticked === checklist.length ? ' badge--success' : ''}`;
      const out = problemsNow();
      save.disabled = out.length > 0 || ticked < checklist.length;
      save.textContent = depositValue == null ? 'Save sale' : `Save sale · ${money(depositValue, depositValue % 1 !== 0)} deposit`;
      missing.textContent = out.length ? `Still needed: ${out.join(', ')}.` : ticked < checklist.length ? `Tick all ${checklist.length} boxes to save.` : 'Ready to save.';
    }
    for (const input of [ticket, name, phone, email, jobDate]) input.addEventListener('input', validate);
    queueMicrotask(validate);
    const submit = event => {
      event.preventDefault();
      validate();
      if (save.disabled) return;
      close({
        ticket: Math.round(amount() * 100) / 100, package: pkg.value(),
        customer: { name: name.value.trim(), phone: normalizePhone(phone.value), email: email.value.trim().toLowerCase() },
        checklist: { ...state.checklist }, jobDate: jobDate.value, jobStartTime: jobTime.value || settings.sale.defaultJobStartTime,
        textConsent: consent.checked, ...(quoted != null ? { quotedAmount: quoted } : {}),
      });
    };
    return h('form', { class: 'screen', onsubmit: submit, novalidate: true },
      h('div', { class: 'row', style: { gap: '8px' } }, dot('sold', { large: true }), h('h1', { style: { fontSize: '24px' } }, 'Nice. Let\'s book it.')),
      h('section', { class: 'stack' },
        h('h2', { style: { fontSize: '18px' } }, 'Customer'),
        field('sale-name', 'Name', name), field('sale-phone', 'Phone', phone), field('sale-email', 'Email', email, h('span', { class: 'hint' }, 'The contract goes here.')),
        h('label', { class: 'check' }, consent, 'OK to text a receipt')),
      h('section', { class: 'stack' },
        h('h2', { style: { fontSize: '18px' } }, 'Package'), pkg.el,
        field('sale-ticket', 'Price', h('div', { class: 'money-field' }, h('span', {}, '$'), ticket))),
      h('section', { class: 'card', style: { gap: '6px' } },
        kv(`${Math.round(settings.sale.depositRate * 100)}% deposit today`, deposit),
        kv('Due on the day', due),
        h('div', { style: { marginTop: '6px' } }, banner('info', 'info', `Full refund if cancelled before midnight ${longDateLabel(window.deadlineDate)}`,
          `So the job can't start before ${longDateLabel(window.earliestJobDate)}. After that the deposit is refundable until ${settings.sale.refundCutoffHours ?? 24} hours before the job.`))),
      h('section', { class: 'stack' },
        h('h2', { style: { fontSize: '18px' } }, 'Job'),
        h('div', { class: 'row row--top', style: { gap: '10px' } },
          h('div', { class: 'grow' }, field('sale-job-date', 'Date', jobDate, h('span', { class: 'hint' }, `Earliest: ${dateLabel(window.earliestJobDate)}`))),
          h('div', { style: { width: '140px', flex: 'none' } }, field('sale-job-time', 'Start', jobTime))),
        dateError),
      h('section', { class: 'stack' },
        h('div', { class: 'row row--between' }, h('h2', { style: { fontSize: '18px' } }, 'Before you save'), count),
        checks),
      h('div', { class: 'stack stack--tight', style: { paddingBottom: '8px' } },
        save, missing,
        h('button', { type: 'button', class: 'btn btn--quiet btn--block', onclick: () => close(null) }, 'Cancel')));
  }).then(details => (details ? onSave(details) : null));
}

async function startSale(house, logSold) {
  return saleForm(house, async details => {
    const knock = await logSold({ quotedAmount: details.ticket });
    if (!knock) return null;
    await app.enqueue('sale', { ...details, knockId: knock.id, houseId: house.id });
    await app.saveUi({ lastAction: { ...app.S.ui.lastAction, outcome: 'sold' } });
    toast(`Sale saved: ${money(details.ticket)}`, { sub: `${details.package} · deposit ${money(depositAmount(details.ticket, app.S.settings.sale.depositRate), true)}`, iconName: 'dollar' });
    return knock;
  });
}

/* ---------- my sales ---------- */

const STATUS_BADGE = {
  booked: ['Booked', 'info', 'clock'], completed: ['Completed', 'success', 'check'],
  paid: ['Paid', 'success', 'dollar'], cancelled: ['Cancelled', 'error', 'close'],
};
const DEPOSIT_BADGE = { collected: ['Collected', 'success'], link_ready: ['Link sent', 'warning'], pending: ['Not yet', ''] };
const monthOf = date => String(date || '').slice(0, 7);

function saleCard(sale, commission) {
  const [label, tone, glyph] = STATUS_BADGE[sale.status] || [sale.status, '', ''];
  const address = `${sale.address.number} ${sale.address.street.split(' ').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ')}`;
  const when = sale.status === 'paid' && sale.paidAt ? `paid ${dateLabel(zonedDate(sale.paidAt))}`
    : sale.status === 'completed' && sale.completedAt ? `done ${dateLabel(zonedDate(sale.completedAt))}`
    : sale.status === 'cancelled' ? `cancelled${sale.cancelledAt ? ` ${dateLabel(zonedDate(sale.cancelledAt))}` : ''}` : `job ${dateLabel(sale.jobDate)}`;
  const depositState = sale.handoff?.deposit?.status || 'pending';
  const [depLabel, depTone] = DEPOSIT_BADGE[depositState] || [depositState, ''];
  const windowOpen = Date.now() < Date.parse(sale.cancelEndsAt || 0);
  const commissionText = !commission ? '—'
    : commission.state === 'earned' ? `${money(commission.amount, true)} · earned`
    : commission.state === 'cancelled' ? '$0'
    : `${money(commission.amount, true)} · ${sale.status === 'completed' ? 'waiting on customer payment' : `earned after ${dateLabel(sale.jobDate)}`}`;
  return h('article', { class: 'card card--line', style: { gap: '10px', opacity: sale.status === 'cancelled' ? '.8' : null } },
    h('div', { class: 'row row--between' }, h('span', { class: 'serif', style: { fontSize: '20px' } }, sale.customer?.name || address), badge(label, tone, glyph)),
    h('div', { class: 'caption muted' }, `${address} · ${sale.package} · ${when}`),
    sale.status !== 'cancelled' ? kv('Price', money(sale.ticket)) : null,
    sale.status !== 'paid' ? kv('Deposit', h('span', { class: 'row', style: { gap: '6px', justifyContent: 'flex-end' } }, badge(depLabel, depTone), money(sale.depositAmount, sale.depositAmount % 1 !== 0))) : null,
    sale.status === 'booked' ? kv('Refund window', windowOpen ? `Open until ${dateLabel(sale.cancelDeadlineDate)}, midnight` : 'Closed', { style: windowOpen ? { color: 'var(--warning)' } : null }) : null,
    kv('Your commission', commissionText, { style: commission?.state === 'earned' ? { color: 'var(--success)' } : null }));
}

function mySalesScreen(_app, params) {
  const period = params.get('p') || 'month';
  const box = h('div', { class: 'screen' }, loadingState(3));
  const pending = app.S.pending.filter(e => e.type === 'sale');
  const load = () => Promise.all([app.api('/api/knock-reports?view=my-sales'), app.api('/api/knock-reports?view=my-money').catch(() => null)]).then(([data, moneyData]) => {
    const commissions = new Map((moneyData?.sales || []).map(s => [s.id, s.commission]));
    const thisMonth = monthOf(zonedDate(Date.now()));
    const lastMonth = monthOf(addDays(`${thisMonth}-01`, -1));
    const shown = data.sales.filter(s => period === 'all' || monthOf(s.saleDate) === (period === 'month' ? thisMonth : lastMonth));
    const countOf = status => shown.filter(s => s.status === status).length;
    mount(box,
      h('div', { class: 'stats stats--3' }, stat('Booked', String(countOf('booked'))), stat('Completed', String(countOf('completed'))), stat('Paid', String(countOf('paid')))),
      seg([['month', 'This month'], ['last', 'Last month'], ['all', 'All']], period, key => app.go('mysales', { p: key }), { label: 'Period' }),
      pending.length ? banner('warn', 'wifiOff', `${pending.length} sale${pending.length === 1 ? '' : 's'} saved on this phone`, 'They show here once they sync.') : null,
      shown.length ? shown.map(sale => saleCard(sale, commissions.get(sale.id)))
        : emptyState('dollar', 'No sales yet', period === 'all' ? 'Your first one shows up here.' : 'Nothing sold in this period. Try All.'));
  }, error => mount(box, errorState(error, () => { mount(box, loadingState(3)); load(); })));
  load();
  return box;
}

export function install(appApi) {
  app = appApi;
  app.saleForm = startSale;
  app.registerScreen('mysales', mySalesScreen, { title: 'My sales', back: 'more' });
  app.moreLinks.push({ route: 'mysales', label: 'My sales', icon: 'dollar', order: 20, hint: 'Bookings, deposits and refund windows' });
}

export { saleForm, timeLabel };
