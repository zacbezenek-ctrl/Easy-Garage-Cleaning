/* The sale form (opened by the Sold button) and the rep's own sales list.
   Nothing is logged until every checklist item is ticked and the job date is after the
   cancellation deadline; the door and the sale then queue together. */
import { h, mount, money, sheet, toast, dateLabel, timeLabel } from './knock-ui.js';
import { PACKAGES } from './knock-settings.js';
import { cancellationWindow, depositAmount } from './knock-sale-rules.js';
import { zonedDate } from './knock-time.js';
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
  return sheet(`Sale at ${houseLabel(house)}`, close => {
    const state = { package: '', checklist: {} };
    const ticket = h('input', { id: 'sale-ticket', type: 'number', inputmode: 'decimal', min: '1', step: '1', value: quoted ? String(quoted) : '', required: true });
    const deposit = h('b', {}, '—');
    const name = h('input', { id: 'sale-name', autocomplete: 'off', autocapitalize: 'words', required: true });
    const phone = h('input', { id: 'sale-phone', type: 'tel', inputmode: 'tel', autocomplete: 'off', placeholder: '(970) 555-0100', required: true });
    const email = h('input', { id: 'sale-email', type: 'email', inputmode: 'email', autocomplete: 'off', autocapitalize: 'none', required: true });
    const jobDate = h('input', { id: 'sale-job-date', type: 'date', min: window.earliestJobDate, value: window.earliestJobDate, required: true });
    const jobTime = h('input', { id: 'sale-job-time', type: 'time', value: settings.sale.defaultJobStartTime });
    const consent = h('input', { type: 'checkbox', id: 'sale-consent' });
    const save = h('button', { type: 'button', class: 'primary wide', disabled: true }, 'Save sale');
    const problems = h('p', { class: 'muted', role: 'status' });
    const packages = h('div', { class: 'grid2' }, PACKAGES.map(pkg => h('button', {
      type: 'button', 'aria-pressed': 'false', class: 'pkg',
      onclick: event => { state.package = pkg; packages.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b === event.currentTarget))); validate(); },
    }, pkg)));
    const checks = (settings.sale.checklist || []).map(item => h('label', { class: 'check' },
      h('input', { type: 'checkbox', onchange: event => { state.checklist[item.key] = event.target.checked; validate(); } }), item.label));

    function problemsNow() {
      const out = [];
      if (!state.package) out.push('pick a package');
      if (!(Number(ticket.value) > 0)) out.push('enter the ticket');
      if (!name.value.trim()) out.push('customer name');
      if (!normalizePhone(phone.value)) out.push('a 10-digit phone');
      if (!EMAIL.test(email.value.trim())) out.push('an email for the contract');
      if (!jobDate.value || jobDate.value < window.earliestJobDate) out.push(`a job date on or after ${dateLabel(window.earliestJobDate)}`);
      if (!(settings.sale.checklist || []).every(item => state.checklist[item.key])) out.push('every checklist item');
      return out;
    }
    function validate() {
      const amount = Number(ticket.value);
      deposit.textContent = amount > 0 ? money(depositAmount(amount, settings.sale.depositRate), true) : '—';
      const missing = problemsNow();
      save.disabled = missing.length > 0;
      problems.textContent = missing.length ? `Still needed: ${missing.join(', ')}.` : 'Ready to save.';
    }
    for (const input of [ticket, name, phone, email, jobDate]) input.addEventListener('input', validate);
    save.addEventListener('click', () => {
      if (problemsNow().length) return validate();
      close({
        ticket: Math.round(Number(ticket.value) * 100) / 100, package: state.package,
        customer: { name: name.value.trim(), phone: normalizePhone(phone.value), email: email.value.trim().toLowerCase() },
        checklist: { ...state.checklist }, jobDate: jobDate.value, jobStartTime: jobTime.value || settings.sale.defaultJobStartTime,
        textConsent: consent.checked, ...(quoted != null ? { quotedAmount: quoted } : {}),
      });
    });
    queueMicrotask(validate);
    return h('div', { class: 'stack' },
      h('label', {}, 'Package'), packages,
      h('div', { class: 'grid2' },
        h('div', {}, h('label', { for: 'sale-ticket' }, 'Ticket ($)'), ticket),
        h('div', {}, h('label', {}, `Deposit (${Math.round(settings.sale.depositRate * 100)}%)`), h('div', { class: 'stat' }, deposit))),
      h('label', { for: 'sale-name' }, 'Customer name'), name,
      h('label', { for: 'sale-phone' }, 'Phone'), phone,
      h('label', { for: 'sale-email' }, 'Email (the contract goes here)'), email,
      h('div', { class: 'grid2' },
        h('div', {}, h('label', { for: 'sale-job-date' }, 'Job date'), jobDate),
        h('div', {}, h('label', { for: 'sale-job-time' }, 'Start time'), jobTime)),
      h('p', { class: 'notice' }, `Right to cancel ends at midnight ${dateLabel(window.deadlineDate)}. The job can be ${dateLabel(window.earliestJobDate)} or later. The deposit is fully refundable until then, and after that until 24 hours before the job.`),
      h('label', { class: 'check' }, consent, 'Customer agreed to one text with their receipt and deposit link'),
      h('h3', {}, 'Before you save'),
      checks, problems, save);
  }).then(details => (details ? onSave(details) : null));
}

async function startSale(house, logSold) {
  return saleForm(house, async details => {
    const knock = await logSold({ quotedAmount: details.ticket });
    if (!knock) return null;
    await app.enqueue('sale', { ...details, knockId: knock.id, houseId: house.id });
    await app.saveUi({ lastAction: { ...app.S.ui.lastAction, outcome: 'sold' } });
    toast(`Sale saved: ${details.package}, ${money(details.ticket)}. Deposit ${money(depositAmount(details.ticket, app.S.settings.sale.depositRate), true)}.`);
    return knock;
  });
}

/* ---------- my sales ---------- */

const STATUS_TONE = { booked: 'warn', completed: 'ok', paid: 'ok', cancelled: 'locked' };

function mySalesScreen() {
  const box = h('div', {}, h('h1', {}, 'My sales'), h('p', { class: 'loading' }, 'Loading…'));
  const pending = app.S.pending.filter(e => e.type === 'sale');
  app.api('/api/knock-reports?view=my-sales').then(data => {
    mount(box, h('h1', {}, 'My sales'),
      pending.length ? h('p', { class: 'notice' }, `${pending.length} sale${pending.length === 1 ? '' : 's'} on this phone waiting to sync.`) : null,
      data.sales.length ? h('ul', { class: 'list' }, data.sales.map(sale => h('li', {},
        h('div', { style: { flex: '1' } },
          h('b', {}, `${sale.address.number} ${sale.address.street}`), ' · ', sale.customer.name, h('br', {}),
          h('span', { class: 'muted' }, `${sale.package} · ${money(sale.ticket)} · job ${dateLabel(sale.jobDate)} · cancel until ${dateLabel(sale.cancelDeadlineDate)}`), h('br', {}),
          h('span', { class: 'muted' }, `Deposit ${money(sale.depositAmount, true)}: ${sale.handoff?.deposit?.status || 'pending'} · ${sale.refund}`)),
        h('span', { class: `badge ${STATUS_TONE[sale.status] || ''}` }, sale.status))))
        : h('p', { class: 'muted' }, 'No sales yet. They show here once synced.'));
  }, error => mount(box, h('h1', {}, 'My sales'), h('p', { class: 'notice error' }, error.status === 0 ? 'Connect to see your sales.' : error.message)));
  return box;
}

export function install(appApi) {
  app = appApi;
  app.saleForm = startSale;
  app.registerScreen('mysales', mySalesScreen);
  app.moreLinks = [...(app.moreLinks || []), ['mysales', 'My sales', 'Bookings, deposits and cancel deadlines']];
}

export { saleForm, timeLabel };
