/* KNOCK-BRIDGE (server flag EGC_KNOCK_JOB_BRIDGE): "Walkthrough set" at the door. The rep takes the customer's name and
   phone and picks an estimator hour (GET /api/knock-walkthrough-slots: day, time and the estimator's first name only),
   or with no signal a day and morning/afternoon. The door and a 'walkthrough' event queue together like a sale; once
   they sync, the phone books the estimator walkthrough (knock-app.js runBridges, POST /api/knock-job-bridge). */
import { h, toast, banner, dot, fullScreen, slotPicker } from './knock-ui.js';
import { houseLabel } from './knock-doors.js';
import { zonedDate, zonedParts } from './knock-time.js';
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
    // REP-WALKTHROUGH: a rep with Walkthroughs on (or anyone who runs walkthroughs) does it now, themselves
    // (knock-bridge.js bookSelfRun books the visit to them and the walkthrough app opens on it). Fixing a refused one
    // offers it again only when the rep had chosen to do it themselves; one set for an estimator keeps its estimator.
    const canRunNow = (!initial || initial.selfRun === true) && app.S.viewer?.walkthroughNow === true && Boolean(app.S.settings?.integrations?.walkthroughUrl);
    const now = canRunNow ? h('button', { type: 'button', class: 'btn btn--secondary btn--xl btn--block', disabled: true, onclick: () => runNow() }, 'Do the walkthrough now') : null;
    const missing = h('p', { class: 'caption muted center' });
    const picker = slotPicker({ min: today, offline: !app.S.online, idPrefix: 'walk-slot', noun: 'walkthrough time', onChange: () => validate(),
      initial: initial ? { mode: 'preference', date: initial.date >= today ? initial.date : today, part: initial.dayPart || dayPartOf(initial.time) } : null,
      load: async () => (await app.api('/api/knock-walkthrough-slots')).slots.map(slot => ({ date: slot.date, time: slot.time, endTime: slot.endTime, tag: slot.estimator, ref: slot.ref })) });
    const schedule = () => {
      const value = picker.value();
      if (!value) return null;
      return value.mode === 'slot' ? { date: value.slot.date, time: value.slot.time, estimatorRef: value.slot.ref } : { date: value.date, dayPart: value.part };
    };
    function customerProblems() {
      const out = [];
      if (!name.value.trim()) out.push('the customer\'s name');
      if (!normalizePhone(phone.value)) out.push('a 10-digit phone');
      if (email.value.trim() && !EMAIL.test(email.value.trim())) out.push('a valid email (or leave it blank)');
      if (zip.value.trim() && !/^\d{5}$/.test(zip.value.trim())) out.push('the 5-digit ZIP');
      return out;
    }
    function validate() {
      const out = customerProblems();
      if (now) now.disabled = out.length > 0;
      if (!schedule()) out.push('a walkthrough time or a day');
      save.disabled = out.length > 0;
      missing.textContent = out.length ? `Still needed: ${out.join(', ')}.` : 'Ready to set.';
    }
    const customerFields = () => ({ customer: { name: name.value.trim(), phone: normalizePhone(phone.value), email: email.value.trim().toLowerCase() },
      city: town.value.trim(), zip: zip.value.trim(), textConsent: consent.checked, ...(note.value.trim() ? { note: note.value.trim() } : {}) });
    // Now, today, in Denver time: the visit is booked to the rep at the minute they tapped.
    function runNow() {
      if (customerProblems().length) return validate();
      if (!app.S.online) {
        toast('No signal', { tone: 'bad', sub: 'The walkthrough opens with signal. Set it for an estimator instead, or try again once you have signal.' });
        return;
      }
      const at = zonedParts(Date.now());
      close({ ...customerFields(), date: at.date, time: `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}`, selfRun: true });
    }
    for (const input of [name, phone, email, zip]) input.addEventListener('input', validate);
    queueMicrotask(validate);
    queueMicrotask(() => picker.reload());
    const submit = event => {
      event.preventDefault();
      validate();
      if (save.disabled) return;
      close({ ...customerFields(), ...schedule() });
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
        save, now, now ? h('span', { class: 'hint center' }, 'You walk the garage and price it yourself, in the walkthrough app.') : null, missing,
        h('button', { type: 'button', class: 'btn btn--quiet btn--block', onclick: () => close(null) }, 'Cancel')));
  }).then(details => (details ? onSave(details) : null));
}

// The door ("Walkthrough set", timed when the rep tapped it) and its walkthrough queue together.
async function startWalkthrough(house, logDoor) {
  return walkthroughForm(house, async details => {
    const knock = await logDoor({});
    if (!knock) return null;
    const event = await app.enqueue('walkthrough', { ...details, knockId: knock.id, houseId: house.id });
    await app.saveUi({ lastAction: { ...app.S.ui.lastAction, outcome: 'walkthrough_set' } });
    if (details.selfRun === true) { await openOwnWalkthrough(event.id); return knock; }
    toast('Walkthrough set', { sub: 'The estimator is booked when it syncs.', iconName: 'calendar' });
    return knock;
  });
}

/* REP-WALKTHROUGH: "Do the walkthrough now". The door and the walkthrough are sent at once, the Hub visit is booked to the
   rep (POST /api/knock-job-bridge), and the walkthrough app opens on it by its Hub id: the customer's details reach the
   walkthrough from the Hub, never through the address bar. If the Hub booked an estimator instead (the rep may not run
   walkthroughs, or the time was refused) the rep is told who comes; if it cannot be reached in time it stays queued and
   books when it syncs. */
export const OWN_WALKTHROUGH_WAIT_MS = 20000;
export async function openOwnWalkthrough(id, { wait = OWN_WALKTHROUGH_WAIT_MS, open = url => location.assign(url) } = {}) {
  const deadline = Date.now() + wait;
  toast('Opening your walkthrough…', { sub: 'Sending the door and booking the visit to you.', iconName: 'calendar' });
  while (Date.now() < deadline) {
    await app.syncBeforeLeaving(Math.min(5000, Math.max(0, deadline - Date.now())));
    try {
      const { booking } = await app.api('/api/knock-job-bridge', { method: 'POST', body: { kind: 'walkthrough', id } });
      if (booking?.selfRun === true && booking.walkthroughId) {
        open(`${app.S.settings.integrations.walkthroughUrl}?walkthroughId=${encodeURIComponent(booking.walkthroughId)}`);
        return booking;
      }
      if (booking && booking.status !== 'pending') {
        toast(booking.message || 'Walkthrough set', { sub: 'It was booked to an estimator instead.', iconName: 'calendar' });
        return booking;
      }
    } catch (error) {
      // Not synced yet (404) or no signal: try again until the wait runs out. Anything else is the office's.
      if (error.status && error.status !== 404 && error.status < 500) { toast('Walkthrough saved', { tone: 'bad', sub: error.message }); return null; }
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  toast('Walkthrough saved', { sub: 'It books when it syncs. Open it from Crew tools once it shows there.', iconName: 'calendar' });
  return null;
}

/* A walkthrough the server refused: the same form with everything the rep typed; saving sends it again. A refused
   "Do the walkthrough now" is sent again the same way (now, at the time tapped) or set for an estimator instead. */
async function fixWalkthrough(event) {
  const house = app.S.houses.get(event.houseId) || { id: event.houseId, number: '', street: 'the house' };
  const details = await walkthroughForm(house, value => value, { initial: event });
  if (!details) return;
  // Clear the earlier pick so a morning/afternoon choice is not sent with a stale estimator slot, nor an estimator's
  // walkthrough with a stale "do it myself".
  await app.outboxApi().resend(event.id, { time: undefined, dayPart: undefined, estimatorRef: undefined, selfRun: undefined, ...details, knockId: event.knockId, houseId: event.houseId });
  await app.refreshPending();
  app.scheduleSync(0);
  if (details.selfRun === true) { await openOwnWalkthrough(event.id); return; }
  toast('Walkthrough sent again', { sub: app.S.online ? 'Syncing now.' : 'It syncs when you have signal.', iconName: 'calendar' });
}

export function install(appApi) {
  app = appApi;
  app.walkthroughForm = startWalkthrough;
  app.fixers.walkthrough = fixWalkthrough;
}

export { walkthroughForm };
