/* The sale form (opened by the Sold button) and the rep's own sales list.
   Nothing is logged until every checklist item is ticked and the job date is after the
   cancellation deadline; the door and the sale then queue together. */
import { h, mount, money, toast, dateLabel, longDateLabel, timeLabel, icon, dot, badge, banner, kv, stat, seg, choiceGroup, emptyState, loadingState, errorState, fullScreen, slotPicker } from './knock-ui.js';
import { PACKAGES } from './knock-settings.js';
import { DAY_PARTS, cancellationWindow, dayPartOf, defaultJobStart, depositAmount, jobMinutes, jobStartAllowed, jobStartFloor } from './knock-sale-rules.js';
import { addDays, zonedDate } from './knock-time.js';
import { houseLabel } from './knock-doors.js';

let app;

export const normalizePhone = value => {
  const digits = String(value || '').replace(/[^\d]/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : '';
};
const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

/* initial: a refused sale's own fields (Edit and resend) so nothing the rep typed is lost. With the server's
   EGC_KNOCK_JOB_BRIDGE on (viewer.jobBridge) the form also takes the town and ZIP and offers crew slots (or, with no
   signal, a day and morning/afternoon); the server books the Hub job after the sale syncs. */
function saleForm(house, onSave, { initial = null } = {}) {
  const settings = app.S.settings;
  const bridge = app.S.viewer?.jobBridge === true;
  const today = zonedDate(initial?.at ? Date.parse(initial.at) : Date.now());
  const window = cancellationWindow(today, { businessDays: settings.sale.cancelBusinessDays, extraHolidays: settings.sale.extraHolidays });
  const quoted = initial?.quotedAmount ?? app.houseView(house.id)?.summary?.quotedAmount;
  const checklist = settings.sale.checklist || [];
  const startFloor = date => jobStartFloor(date) || '00:00';
  return fullScreen(initial ? 'Fix the sale' : 'New sale', houseLabel(house), close => {
    const state = { checklist: initial ? { ...(initial.checklist || {}) } : {} };
    const field = (id, label, input, hint = null) => h('div', { class: 'field' }, h('label', { class: 'label', for: id }, label), input, hint);
    const name = h('input', { class: 'input', id: 'sale-name', autocomplete: 'off', autocapitalize: 'words', required: true, value: initial?.customer?.name || '' });
    const phone = h('input', { class: 'input', id: 'sale-phone', type: 'tel', inputmode: 'tel', autocomplete: 'off', placeholder: '(970) 555-0100', required: true, value: initial?.customer?.phone || '' });
    const email = h('input', { class: 'input', id: 'sale-email', type: 'email', inputmode: 'email', autocomplete: 'off', autocapitalize: 'none', required: true, value: initial?.customer?.email || '' });
    const consent = h('input', { type: 'checkbox', id: 'sale-consent', checked: initial?.textConsent === true });
    const pkg = choiceGroup(PACKAGES.map(p => [p, p]), initial?.package || '', () => { validate(); packageChanged(); });
    const ticket = h('input', { class: 'input input--money', id: 'sale-ticket', type: 'text', inputmode: 'decimal', autocomplete: 'off', value: initial?.ticket != null ? String(initial.ticket) : quoted ? String(quoted) : '', required: true });
    // KNOCK-BRIDGE: where the Hub customer and job are. The town comes from the neighborhood; the rep adds the ZIP.
    const town = h('input', { class: 'input', id: 'sale-city', autocomplete: 'off', autocapitalize: 'words', value: initial?.city ?? app.cityRuleFor(house)?.name ?? '' });
    const zip = h('input', { class: 'input', id: 'sale-zip', inputmode: 'numeric', autocomplete: 'off', maxlength: '5', placeholder: '80525', value: initial?.zip || '' });
    const deposit = h('b', { class: 'serif', style: { fontSize: '22px' } }, '—');
    const due = h('b', {}, '—');
    const firstDate = initial?.jobDate && initial.jobDate >= window.earliestJobDate ? initial.jobDate : window.earliestJobDate;
    const jobDate = h('input', { class: 'input', id: 'sale-job-date', type: 'date', min: window.earliestJobDate, value: firstDate, required: true });
    // Jobs start at 9:30 or later (the owner's rule); the settings default never starts earlier.
    const jobTime = h('input', { class: 'input', id: 'sale-job-time', type: 'time', min: startFloor(firstDate) === '00:00' ? null : startFloor(firstDate), value: initial?.jobStartTime || defaultJobStart(settings, firstDate) });
    const dateError = h('span', { class: 'error-text', hidden: true }, icon('alert', { size: 'sm' }), `Pick a day on or after ${longDateLabel(window.earliestJobDate)}.`);
    const count = h('span', { class: 'badge' }, `0 of ${checklist.length}`);
    const save = h('button', { type: 'submit', class: 'btn btn--success btn--xl btn--block', disabled: true }, 'Save sale');
    const missing = h('p', { class: 'caption muted center' });
    const checks = checklist.map(item => h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: state.checklist[item.key] === true, onchange: event => { state.checklist[item.key] = event.target.checked; validate(); } }), item.label));
    const amount = () => Number(String(ticket.value).replace(/[$,\s]/g, ''));
    // The crew slots the server offers for this package on and after the earliest job date (GET /api/knock-crew-openings).
    // One read per job length for the life of the form: packages of the same length share it, and tapping back to a
    // package reads nothing (each read is a schedule search on the server).
    let picker = null, shownLength = null;
    const slotReads = new Map();
    if (bridge) {
      const initialPick = initial?.slot ? { mode: 'slot', slot: { date: initial.slot.date, time: initial.slot.time, tag: initial.slot.crewLabel || 'Crew' } }
        : initial ? { mode: 'preference', date: firstDate, part: initial.dayPart || dayPartOf(initial.jobStartTime) } : null;
      picker = slotPicker({ min: window.earliestJobDate, initial: initialPick, offline: !app.S.online, idPrefix: 'sale-slot', noun: 'crew time', onChange: () => validate(),
        load: () => {
          const length = jobMinutes(pkg.value() || null);
          shownLength = length;
          if (!slotReads.has(length)) {
            const query = new URLSearchParams({ from: window.earliestJobDate, days: '7', ...(pkg.value() ? { package: pkg.value() } : {}) });
            slotReads.set(length, app.api(`/api/knock-crew-openings?${query}`).then(data => data.slots.map(slot => ({ date: slot.date, time: slot.time, endTime: slot.endTime, tag: slot.crewLabel })),
              error => { slotReads.delete(length); throw error; }));
          }
          return slotReads.get(length);
        } });
    }
    // A package of another length shows that length's slots; the same length keeps the list (and the rep's pick).
    const packageChanged = () => { if (picker && jobMinutes(pkg.value() || null) !== shownLength) picker.reload(); };

    function schedule() {
      if (!bridge) return { jobDate: jobDate.value, jobStartTime: jobTime.value || defaultJobStart(settings, jobDate.value) };
      const pickValue = picker.value();
      if (!pickValue) return null;
      if (pickValue.mode === 'slot') return { jobDate: pickValue.slot.date, jobStartTime: pickValue.slot.time, slot: { date: pickValue.slot.date, time: pickValue.slot.time, crewLabel: pickValue.slot.tag } };
      return { jobDate: pickValue.date, jobStartTime: DAY_PARTS[pickValue.part].start, dayPart: pickValue.part };
    }
    function problemsNow() {
      const out = [];
      if (!name.value.trim()) out.push('the customer\'s name');
      if (!normalizePhone(phone.value)) out.push('a 10-digit phone');
      if (!EMAIL.test(email.value.trim())) out.push('an email for the contract');
      if (!pkg.value()) out.push('a package');
      if (!(amount() > 0)) out.push('the price');
      if (bridge) {
        if (!/^\d{5}$/.test(zip.value.trim())) out.push('the 5-digit ZIP');
        const when = schedule();
        if (!when) out.push('a crew time or a day');
        else if (when.jobDate < window.earliestJobDate) out.push(`a job date on or after ${dateLabel(window.earliestJobDate)}`);
      } else {
        if (!jobDate.value || jobDate.value < window.earliestJobDate) out.push(`a job date on or after ${dateLabel(window.earliestJobDate)}`);
        if (jobTime.value && !jobStartAllowed(jobDate.value, jobTime.value)) out.push('a start at 9:30 am or later');
      }
      return out;
    }
    function validate() {
      const value = amount();
      const depositValue = value > 0 ? depositAmount(value, settings.sale.depositRate) : null;
      deposit.textContent = depositValue == null ? '—' : money(depositValue, depositValue % 1 !== 0);
      due.textContent = depositValue == null ? '—' : money(value - depositValue, (value - depositValue) % 1 !== 0);
      dateError.hidden = bridge || !jobDate.value || jobDate.value >= window.earliestJobDate;
      jobDate.classList.toggle('input--error', !dateError.hidden);
      const floor = startFloor(jobDate.value);
      if (floor !== '00:00') jobTime.min = floor; else jobTime.removeAttribute('min');
      const ticked = checklist.filter(item => state.checklist[item.key]).length;
      count.textContent = `${ticked} of ${checklist.length}`;
      count.className = `badge${ticked === checklist.length ? ' badge--success' : ''}`;
      const out = problemsNow();
      save.disabled = out.length > 0 || ticked < checklist.length;
      save.textContent = depositValue == null ? 'Save sale' : `Save sale · ${money(depositValue, depositValue % 1 !== 0)} deposit`;
      missing.textContent = out.length ? `Still needed: ${out.join(', ')}.` : ticked < checklist.length ? `Tick all ${checklist.length} boxes to save.` : 'Ready to save.';
    }
    for (const input of [ticket, name, phone, email, jobDate, jobTime, zip]) input.addEventListener('input', validate);
    queueMicrotask(validate);
    if (picker) queueMicrotask(() => picker.reload());
    const submit = event => {
      event.preventDefault();
      validate();
      if (save.disabled) return;
      close({
        ticket: Math.round(amount() * 100) / 100, package: pkg.value(),
        customer: { name: name.value.trim(), phone: normalizePhone(phone.value), email: email.value.trim().toLowerCase() },
        checklist: { ...state.checklist }, ...schedule(),
        ...(bridge ? { city: town.value.trim(), zip: zip.value.trim() } : {}),
        textConsent: consent.checked, ...(quoted != null ? { quotedAmount: quoted } : {}),
      });
    };
    return h('form', { class: 'screen', onsubmit: submit, novalidate: true },
      h('div', { class: 'row', style: { gap: '8px' } }, dot('sold', { large: true }), h('h1', { style: { fontSize: '24px' } }, initial ? 'Fix it and send it again.' : 'Nice. Let\'s book it.')),
      initial?.error?.message ? banner('error', 'alert', 'The office could not save this sale', initial.error.message) : null,
      h('section', { class: 'stack' },
        h('h2', { style: { fontSize: '18px' } }, 'Customer'),
        field('sale-name', 'Name', name), field('sale-phone', 'Phone', phone), field('sale-email', 'Email', email, h('span', { class: 'hint' }, 'The contract goes here.')),
        h('label', { class: 'check' }, consent, 'OK to text a receipt'),
        bridge ? h('div', { class: 'row row--top', style: { gap: '10px' } },
          h('div', { class: 'grow' }, field('sale-city', 'Town', town)),
          h('div', { style: { width: '120px', flex: 'none' } }, field('sale-zip', 'ZIP', zip))) : null),
      h('section', { class: 'stack' },
        h('h2', { style: { fontSize: '18px' } }, 'Package'), pkg.el,
        field('sale-ticket', 'Price', h('div', { class: 'money-field' }, h('span', {}, '$'), ticket))),
      h('section', { class: 'card', style: { gap: '6px' } },
        kv(`${Math.round(settings.sale.depositRate * 100)}% deposit`, deposit),
        kv('Remainder due on job day', due),
        h('div', { style: { marginTop: '6px' } }, banner('info', 'info', `Full refund if cancelled before midnight ${longDateLabel(window.deadlineDate)}`,
          `So the job can't start before ${longDateLabel(window.earliestJobDate)}. After that the deposit is refundable until ${settings.sale.refundCutoffHours ?? 24} hours before the job.`))),
      h('section', { class: 'stack' },
        h('h2', { style: { fontSize: '18px' } }, bridge ? 'Crew and day' : 'Job'),
        bridge ? [h('p', { class: 'caption muted' }, `Earliest: ${dateLabel(window.earliestJobDate)}. The office books the crew when this syncs; if a time is gone, the next free crew or time is booked.`), picker.el]
          : [h('div', { class: 'row row--top', style: { gap: '10px' } },
            h('div', { class: 'grow' }, field('sale-job-date', 'Date', jobDate, h('span', { class: 'hint' }, `Earliest: ${dateLabel(window.earliestJobDate)}`))),
            h('div', { style: { width: '140px', flex: 'none' } }, field('sale-job-time', 'Start', jobTime, h('span', { class: 'hint' }, '9:30 am or later')))),
          dateError]),
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
    toast(`Sale saved: ${money(details.ticket)}`, { sub: app.S.viewer?.jobBridge ? 'The crew is booked when it syncs.' : `${details.package} · deposit ${money(depositAmount(details.ticket, app.S.settings.sale.depositRate), true)}`, iconName: 'dollar' });
    return knock;
  });
}

/* A sale the server refused: the same form with everything the rep typed; saving sends it again (same id). */
async function fixSale(event) {
  const house = app.S.houses.get(event.houseId) || { id: event.houseId, number: '', street: 'the sold house' };
  const details = await saleForm(house, value => value, { initial: event });
  if (!details) return;
  // A new pick replaces the old one: a crew slot and a morning/afternoon choice are never both sent.
  await app.outboxApi().resend(event.id, { slot: undefined, dayPart: undefined, ...details, knockId: event.knockId, houseId: event.houseId });
  await app.refreshPending();
  app.scheduleSync(0);
  toast('Sale sent again', { sub: app.S.online ? 'Syncing now.' : 'It syncs when you have signal.', iconName: 'dollar' });
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
    : ['unconfigured', 'review_required'].includes(commission.state) ? 'Needs review'
    : commission.state === 'excluded' ? '$0 - not commission eligible'
    : commission.state === 'earned' ? `${money(commission.amount, true)} · earned`
    : commission.state === 'cancelled' ? '$0'
    : `${money(commission.amount, true)} · pending collection and review`;
  return h('article', { class: 'card card--line', style: { gap: '10px', opacity: sale.status === 'cancelled' ? '.8' : null } },
    h('div', { class: 'row row--between' }, h('span', { class: 'serif', style: { fontSize: '20px' } }, sale.customer?.name || address), badge(label, tone, glyph)),
    h('div', { class: 'caption muted' }, `${address} · ${sale.package} · ${when}`),
    sale.status !== 'cancelled' ? kv('Price', money(sale.ticket)) : null,
    sale.status !== 'paid' ? kv('Deposit', h('span', { class: 'row', style: { gap: '6px', justifyContent: 'flex-end' } }, badge(depLabel, depTone), money(sale.depositAmount, sale.depositAmount % 1 !== 0))) : null,
    sale.status === 'booked' ? kv('Refund window', windowOpen ? `Open until ${dateLabel(sale.cancelDeadlineDate)}, midnight` : 'Closed', { style: windowOpen ? { color: 'var(--warning)' } : null }) : null,
    kv('Your commission', commissionText, { style: commission?.state === 'earned' ? { color: 'var(--success)' } : null }),
    // KNOCK-BRIDGE: where the Hub booked the job (day, time and crew), as the server answered it.
    bookingLine(sale.hubJob || app.bookingFor(sale.id)),
    // GUARD-SELL: offer this customer a Garage Guard membership (crew/knock-guard.js), pre-filled from the sale.
    app.sellGuard && sale.status !== 'cancelled' ? h('button', { type: 'button', class: 'btn btn--quiet btn--block', onclick: () => app.sellGuard(guardCustomer(sale), { jobId: sale.handoff?.job?.jobId || '', customerId: sale.handoff?.job?.customerId || '' }) }, 'Offer Garage Guard') : null);
}

// GUARD-SELL: the sale's customer for the Garage Guard sheet: name, email and the house address with its town.
function guardCustomer(sale) {
  const a = sale.address || {}, street = [a.number, a.street, a.unit].filter(Boolean).join(' ');
  return { name: sale.customer?.name || '', email: sale.customer?.email || '', address: [street, sale.city || a.city || ''].filter(Boolean).join(', ') };
}

const BOOKING_BADGE = { booked: ['Booked', 'success', 'check'], needs_crew: ['Crew to confirm', 'warning', 'clock'], requested: ['Office sets the time', 'warning', 'clock'], review: ['Office books it', 'warning', 'clock'], pending: ['Booking…', '', 'clock'],
  cancelled: ['Cancelled', 'error', 'close'], superseded: ['Replaced by the sale', '', 'check'] };
function bookingLine(booking) {
  if (!booking) return null;
  const [label, tone, glyph] = BOOKING_BADGE[booking.status] || BOOKING_BADGE.pending;
  return h('div', { class: 'row row--between wrap', style: { gap: '6px' }, 'data-booking': booking.status }, h('span', { class: 'caption' }, booking.message), badge(label, tone, glyph));
}

// KNOCK-BRIDGE: the walkthroughs this rep set at the door and where they were booked (estimator's first name only).
function walkthroughCard(row) {
  const address = `${row.address.number} ${row.address.street.split(' ').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ')}`;
  return h('article', { class: 'card card--line', style: { gap: '8px' } },
    h('div', { class: 'row row--between' }, h('span', { class: 'serif', style: { fontSize: '18px' } }, row.customer?.name || address), dot('walkthrough_set', { large: true })),
    h('div', { class: 'caption muted' }, `${address} · set ${dateLabel(zonedDate(row.setAt))}`),
    bookingLine({ ...row.booking, message: row.booking.message || (row.booking.status === 'pending' ? 'Saved. Booking it with the office…' : '') }));
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
    // KNOCK-BRIDGE: a sale or walkthrough the server still lists as booking (its first answer lost, or the app closed
    // before it was queued) goes back in the booking queue; the server answers it from the record until it is due.
    const open = [...data.sales.filter(s => s.hubJob?.status === 'pending' && s.status !== 'cancelled').map(s => ({ kind: 'sale', id: s.id })),
      ...(data.walkthroughs || []).filter(w => ['pending', 'retry'].includes(w.booking?.status || 'pending') && w.status === 'set').map(w => ({ kind: 'walkthrough', id: w.id }))];
    if (open.length && app.queueBridges) app.queueBridges(open).then(() => app.runBridges()).then(changed => { if (changed && app.S.route.name === 'mysales') app.render(); }).catch(() => {});
    mount(box,
      h('div', { class: 'stats stats--3' }, stat('Booked', String(countOf('booked'))), stat('Completed', String(countOf('completed'))), stat('Paid', String(countOf('paid')))),
      seg([['month', 'This month'], ['last', 'Last month'], ['all', 'All']], period, key => app.go('mysales', { p: key }), { label: 'Period' }),
      pending.length ? banner('warn', 'wifiOff', `${pending.length} sale${pending.length === 1 ? '' : 's'} saved on this phone`, 'They show here once they sync.') : null,
      shown.length ? shown.map(sale => saleCard(sale, commissions.get(sale.id)))
        : emptyState('dollar', 'No sales yet', period === 'all' ? 'Your first one shows up here.' : 'Nothing sold in this period. Try All.'),
      data.walkthroughs?.length ? h('section', { class: 'stack stack--tight' }, h('h2', { style: { fontSize: '18px' } }, 'Walkthroughs you set'), data.walkthroughs.map(walkthroughCard)) : null);
  }, error => mount(box, errorState(error, () => { mount(box, loadingState(3)); load(); })));
  load();
  return box;
}

export function install(appApi) {
  app = appApi;
  app.saleForm = startSale;
  app.fixers.sale = fixSale;
  app.registerScreen('mysales', mySalesScreen, { title: 'My sales', back: 'more' });
  app.moreLinks.push({ route: 'mysales', label: 'My sales', icon: 'dollar', order: 20, hint: 'Bookings, deposits and refund windows' });
  // GUARD-SELL: More > Sell Garage Guard and the Offer Garage Guard button on a sale (crew/knock-guard.js). It needs a
  // connection like the sheet itself, so a phone that cannot load it simply goes without.
  import('./knock-guard.js').then(guard => { guard.install(app); if (['guard', 'more', 'mysales'].includes(app.S.route?.name)) app.render(); })
    .catch(error => console.warn('EGC Knock: Garage Guard selling failed to load.', error));
}

export { saleForm, timeLabel };
