/* KNOCK-BRIDGE (server flag EGC_KNOCK_JOB_BRIDGE): "Walkthrough set" at the door. The rep takes the customer's name and
   phone and picks an estimator hour (GET /api/knock-walkthrough-slots: day, time and the estimator's first name only),
   or with no signal a day and morning/afternoon. The door and a 'walkthrough' event queue together like a sale; once
   they sync, the phone books the estimator walkthrough (knock-app.js runBridges, POST /api/knock-job-bridge). */
import { h, toast, banner, dot, fullScreen, slotPicker } from './knock-ui.js';
import { houseLabel } from './knock-doors.js';
import { zonedDate } from './knock-time.js';
import { dayPartOf } from './knock-sale-rules.js';

let app;

const normalizePhone = value => {
  const digits = String(value || '').replace(/[^\d]/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(ten) ? `+1${ten}` : '';
};
const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

// initial: a refused walkthrough's own fields (Edit and resend), so nothing the rep typed is lost.
function walkthroughForm(house, onSave, { initial = null } = {}) {
  const today = zonedDate(Date.now());
  return fullScreen(initial ? 'Fix the walkthrough' : 'Set a walkthrough', houseLabel(house), close => {
    const field = (id, label, input, hint = null) => h('div', { class: 'field' }, h('label', { class: 'label', for: id }, label), input, hint);
    const name = h('input', { class: 'input', id: 'walk-name', autocomplete: 'off', autocapitalize: 'words', required: true, value: initial?.customer?.name || '' });
    const phone = h('input', { class: 'input', id: 'walk-phone', type: 'tel', inputmode: 'tel', autocomplete: 'off', placeholder: '(970) 555-0100', required: true, value: initial?.customer?.phone || '' });
    const email = h('input', { class: 'input', id: 'walk-email', type: 'email', inputmode: 'email', autocomplete: 'off', autocapitalize: 'none', value: initial?.customer?.email || '' });
    const town = h('input', { class: 'input', id: 'walk-city', autocomplete: 'off', autocapitalize: 'words', value: initial?.city ?? app.cityRuleFor(house)?.name ?? '' });
    const zip = h('input', { class: 'input', id: 'walk-zip', inputmode: 'numeric', autocomplete: 'off', maxlength: '5', placeholder: '80525', value: initial?.zip || '' });
    const consent = h('input', { type: 'checkbox', id: 'walk-consent', checked: initial?.textConsent === true });
    const note = h('textarea', { class: 'input input--area', id: 'walk-note', maxlength: '480', placeholder: 'What\'s in the garage, what they want done…' });
    note.value = initial?.note || '';
    const save = h('button', { type: 'submit', class: 'btn btn--primary btn--xl btn--block', disabled: true }, 'Set walkthrough');
    const missing = h('p', { class: 'caption muted center' });
    const picker = slotPicker({ min: today, offline: !app.S.online, idPrefix: 'walk-slot', noun: 'walkthrough time', onChange: () => validate(),
      initial: initial ? { mode: 'preference', date: initial.date >= today ? initial.date : today, part: initial.dayPart || dayPartOf(initial.time) } : null,
      load: async () => (await app.api('/api/knock-walkthrough-slots')).slots.map(slot => ({ date: slot.date, time: slot.time, endTime: slot.endTime, tag: slot.estimator, ref: slot.ref })) });
    const schedule = () => {
      const value = picker.value();
      if (!value) return null;
      return value.mode === 'slot' ? { date: value.slot.date, time: value.slot.time, estimatorRef: value.slot.ref } : { date: value.date, dayPart: value.part };
    };
    function validate() {
      const out = [];
      if (!name.value.trim()) out.push('the customer\'s name');
      if (!normalizePhone(phone.value)) out.push('a 10-digit phone');
      if (email.value.trim() && !EMAIL.test(email.value.trim())) out.push('a valid email (or leave it blank)');
      if (zip.value.trim() && !/^\d{5}$/.test(zip.value.trim())) out.push('the 5-digit ZIP');
      if (!schedule()) out.push('a walkthrough time or a day');
      save.disabled = out.length > 0;
      missing.textContent = out.length ? `Still needed: ${out.join(', ')}.` : 'Ready to set.';
    }
    for (const input of [name, phone, email, zip]) input.addEventListener('input', validate);
    queueMicrotask(validate);
    queueMicrotask(() => picker.reload());
    const submit = event => {
      event.preventDefault();
      validate();
      if (save.disabled) return;
      close({
        customer: { name: name.value.trim(), phone: normalizePhone(phone.value), email: email.value.trim().toLowerCase() },
        ...schedule(), city: town.value.trim(), zip: zip.value.trim(), textConsent: consent.checked, ...(note.value.trim() ? { note: note.value.trim() } : {}),
      });
    };
    return h('form', { class: 'screen', onsubmit: submit, novalidate: true },
      h('div', { class: 'row', style: { gap: '8px' } }, dot('walkthrough_set', { large: true }), h('h1', { style: { fontSize: '24px' } }, initial ? 'Fix it and send it again.' : 'An estimator comes to them.')),
      initial?.error?.message ? banner('error', 'alert', 'The office could not save this walkthrough', initial.error.message) : null,
      h('section', { class: 'stack' },
        h('h2', { style: { fontSize: '18px' } }, 'Customer'),
        field('walk-name', 'Name', name), field('walk-phone', 'Phone', phone),
        field('walk-email', 'Email', email, h('span', { class: 'hint' }, 'Optional')),
        h('div', { class: 'row row--top', style: { gap: '10px' } },
          h('div', { class: 'grow' }, field('walk-city', 'Town', town)),
          h('div', { style: { width: '120px', flex: 'none' } }, field('walk-zip', 'ZIP', zip))),
        h('label', { class: 'check' }, consent, 'OK to text a reminder')),
      h('section', { class: 'stack' },
        h('h2', { style: { fontSize: '18px' } }, 'When'),
        h('p', { class: 'caption muted' }, 'The office books the estimator when this syncs. If the time is gone, another estimator or the next free hour is booked.'),
        picker.el),
      h('section', { class: 'stack' }, field('walk-note', 'Note', note, h('span', { class: 'hint' }, 'Optional. The estimator sees it.'))),
      h('div', { class: 'stack stack--tight', style: { paddingBottom: '8px' } },
        save, missing,
        h('button', { type: 'button', class: 'btn btn--quiet btn--block', onclick: () => close(null) }, 'Cancel')));
  }).then(details => (details ? onSave(details) : null));
}

// The door ("Walkthrough set", timed when the rep tapped it) and its walkthrough queue together.
async function startWalkthrough(house, logDoor) {
  return walkthroughForm(house, async details => {
    const knock = await logDoor({});
    if (!knock) return null;
    await app.enqueue('walkthrough', { ...details, knockId: knock.id, houseId: house.id });
    await app.saveUi({ lastAction: { ...app.S.ui.lastAction, outcome: 'walkthrough_set' } });
    toast('Walkthrough set', { sub: 'The estimator is booked when it syncs.', iconName: 'calendar' });
    return knock;
  });
}

/* A walkthrough the server refused: the same form with everything the rep typed; saving sends it again. */
async function fixWalkthrough(event) {
  const house = app.S.houses.get(event.houseId) || { id: event.houseId, number: '', street: 'the house' };
  const details = await walkthroughForm(house, value => value, { initial: event });
  if (!details) return;
  // Clear the earlier pick so a morning/afternoon choice is not sent with a stale estimator slot.
  await app.outboxApi().resend(event.id, { time: undefined, dayPart: undefined, estimatorRef: undefined, ...details, knockId: event.knockId, houseId: event.houseId });
  await app.refreshPending();
  app.scheduleSync(0);
  toast('Walkthrough sent again', { sub: app.S.online ? 'Syncing now.' : 'It syncs when you have signal.', iconName: 'calendar' });
}

export function install(appApi) {
  app = appApi;
  app.walkthroughForm = startWalkthrough;
  app.fixers.walkthrough = fixWalkthrough;
}

export { walkthroughForm };
