/* Rep screens: the shift card, one-tap door logging, the list, go-backs and the come-back and
   look sheets. Every tap is an append-only event queued on the phone and synced in the background. */
import { h, toast, sheet, money, hoursLabel, dateLabel, icon, dot, badge, banner, seg, choiceGroup, emptyState, distanceLabel } from './knock-ui.js';
import { OUTCOME_LABELS, PACKAGES } from './knock-settings.js';
import { OUTCOME_COLORS, goBackSuggestion, houseLabel, nearestSuggestion, nextOnStreet, titleStreet } from './knock-doors.js';
import { doorAllowed, formatClock, zonedDate, zonedInstant, zonedParts, addDays, weekday } from './knock-time.js';
import { shiftTiming } from './knock-stats.js';

let app;
let watchId = null;

const OUTCOME_ORDER = ['no_answer', 'not_interested', 'come_back', 'look', 'sold', 'skipped_sign'];
const OUTCOME_BUTTONS = {
  no_answer: ['noanswer', 'bell', 'No answer'],
  not_interested: ['notint', 'close', 'Not interested'],
  come_back: ['comeback', 'comeBack', 'Come back'],
  look: ['look', 'eye', 'Look'],
  sold: ['sold', 'dollar', 'Sold'],
  skipped_sign: ['skip', 'ban', 'Skipped', 'No-soliciting sign'],
};
const S = () => app.S;
const tz = () => app.cityRuleFor(null)?.timeZone || 'America/Denver';

/* ---------- helpers ---------- */

function houseEntries({ neighborhoodId = null } = {}) {
  const entries = [];
  for (const house of S().houses.values()) {
    if (neighborhoodId && house.n !== neighborhoodId) continue;
    const view = app.houseView(house.id);
    entries.push({ house, summary: view.summary, status: view.status });
  }
  return entries;
}

const byAddress = (a, b) => a.house.street.localeCompare(b.house.street) || Number.parseInt(a.house.number, 10) - Number.parseInt(b.house.number, 10) || String(a.house.unit || '').localeCompare(String(b.house.unit || ''));

function dotKind(entry) {
  if (entry.status.status === 'blocked') return 'blocked';
  return entry.summary?.lastOutcome || 'none';
}

function colorFor(entry) {
  if (entry.status.status === 'blocked') return OUTCOME_COLORS.blocked;
  return OUTCOME_COLORS[entry.summary?.lastOutcome || 'none'] || OUTCOME_COLORS.none;
}

function bucketLabel(key) {
  return (S().settings.goBacks.buckets || []).find(b => b.key === key)?.label?.toLowerCase() || key;
}

// When to come back, in a few words: "after 5 pm", "Thu, Oct 8 · morning".
function whenLabel(iso) {
  const parts = zonedParts(iso, tz());
  if (!parts) return '';
  const today = zonedDate(Date.now(), tz());
  const day = parts.date === today ? 'today' : parts.date === addDays(today, 1) ? 'tomorrow' : dateLabel(parts.date);
  return `${day} ${formatClock(Date.parse(iso), tz())}`;
}

function goBackTip(entry) {
  const tip = goBackSuggestion(entry.summary, { ...S().settings, timeZone: tz() });
  if (tip.kind === 'requested') return `back ${whenLabel(tip.at)}`;
  if (tip.kind === 'bucket') return `try ${bucketLabel(tip.bucket)}`;
  return 'any time';
}

const myNote = houseId => S().ui.notes?.[houseId]?.text || '';

function statusText(entry) {
  const st = entry.status, summary = entry.summary || {};
  if (st.status === 'go_back') return `${summary.lastOutcome === 'no_answer' ? 'No answer' : 'Come back'} · ${st.attemptsLeft} left · ${goBackTip(entry)}`;
  if (st.status === 'resting') return `Not interested · rests until ${new Date(st.restUntil).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  if (st.status === 'new') return 'Not knocked yet';
  if (st.status === 'rested') return 'Rest period over · knock again';
  if (st.status === 'blocked') return st.reason.includes('City') ? 'City no-knock list · don\'t knock' : 'No-soliciting sign · don\'t knock';
  if (st.status === 'done') return summary.lastOutcome === 'sold' ? `Sold${summary.lastAt ? ` · ${dateLabel(zonedDate(summary.lastAt, tz()))}` : ''}` : `Look${summary.quotedAmount ? ` · quoted ${money(summary.quotedAmount)}` : ''}`;
  if (st.status === 'max_attempts') return `${st.reason} · done for the season`;
  return st.reason || st.status;
}

function lastOutcomeLine(summary) {
  if (!summary?.lastOutcome || !summary.lastAt) return '';
  return `Last: ${OUTCOME_LABELS[summary.lastOutcome]} · ${dateLabel(zonedDate(summary.lastAt, tz()))} · ${formatClock(Date.parse(summary.lastAt), tz())}`;
}

function startWatchingPosition() {
  if (watchId != null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(position => {
    const first = !S().position;
    S().position = { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy, at: Date.now() };
    // A house picked before the first GPS fix was picked in street order: swap it for the nearest one.
    if (first && S().ui.pickedWithoutGps) {
      const near = nearestSuggestion(houseEntries().filter(e => e.status.knockable), S().position);
      if (near) selectHouse(near.house).then(() => app.render());
    }
  }, () => {}, { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 });
}

function suggestedHouse() {
  const entries = houseEntries().filter(e => e.status.knockable);
  if (!entries.length) return null;
  const near = nearestSuggestion(entries, S().position);
  if (near) return near.house;
  const sorted = entries.sort(byAddress);
  return (sorted.find(e => e.status.status === 'new') || sorted[0]).house;
}

function currentHouse() {
  const id = S().ui.houseId;
  return (id && S().houses.get(id)) || null;
}

async function selectHouse(house, { previousNumber = null } = {}) {
  await app.saveUi({ houseId: house?.id || null, previousNumber, pickedWithoutGps: false });
}

async function rememberNote(houseId, text) {
  if (!text) return;
  // The rep's own notes stay on this phone for their go-backs; the server keeps them on the door record.
  const notes = Object.entries({ ...(S().ui.notes || {}), [houseId]: { text, at: new Date().toISOString() } })
    .sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, 300);
  await app.saveUi({ notes: Object.fromEntries(notes) });
}

/* ---------- shift ---------- */

async function startShift() {
  const window = app.knockingWindow();
  if (!S().eligibility.ok) return toast(S().eligibility.reason, { tone: 'bad' });
  if (window.phase === 'before') return toast(`Knocking opens at ${window.startLabel}.`, { tone: 'bad' });
  if (window.phase !== 'open') return toast(`Sunset was ${window.endLabel}. Knocking is closed for today.`, { tone: 'bad' });
  const unlocked = S().territory.neighborhoods.filter(n => !n.locked);
  if (!unlocked.length) return toast('Nothing open is assigned to you yet.', { tone: 'bad' });
  const shiftId = crypto.randomUUID();
  await app.enqueue('shift.start', { shiftId, cityKey: unlocked[0].cityKey });
  // A new shift starts at the house nearest the rep, not where the last shift stopped.
  await app.saveUi({ graceDoorFor: null, houseId: null, previousNumber: null });
  startWatchingPosition();
  toast('Shift started', { sub: 'Knock safe and friendly.', iconName: 'play' });
  app.go('knock');
}

async function toggleBreak(shift) {
  const open = (shift.breaks || []).find(b => !b.endAt);
  await app.enqueue(open ? 'shift.break_end' : 'shift.break_start', { shiftId: shift.id });
  toast(open ? 'Back on the clock' : 'On a break', { sub: open ? 'Outcomes are on again.' : 'Knocking time is paused.', iconName: open ? 'play' : 'pause' });
  app.render();
}

async function endShift(shift) {
  await app.enqueue('shift.end', { shiftId: shift.id, reason: 'manual' });
  toast('Shift ended', { sub: `${shift.doors || 0} doors · ${hoursLabel(shift.timing.knockingMs)} knocking.` });
  app.go('home');
}

function startButton() {
  const window = app.knockingWindow();
  const blocked = !S().eligibility.ok ? S().eligibility.reason
    : window.phase === 'before' ? `Knocking opens at ${window.startLabel}.`
    : window.phase !== 'open' ? `Sunset was ${window.endLabel}. Knocking is closed for today.` : '';
  return h('div', { class: 'stack stack--tight' },
    h('button', { type: 'button', class: 'btn btn--primary btn--xl btn--block', style: { minHeight: '88px', fontSize: '28px' }, disabled: Boolean(blocked), onclick: startShift },
      icon('play', { size: 'lg' }), 'Start shift'),
    h('p', { class: 'caption muted center' }, blocked || `A shift that sits idle for ${S().settings.shift.idleAutoEndHours} hours ends on its own.`));
}

export function shiftCard({ onKnock = false } = {}) {
  const shift = app.currentShift();
  if (!shift) return startButton();
  const onBreak = shift.timing.onBreak;
  return h('section', { class: 'card' },
    h('div', { class: 'row row--between' },
      onBreak ? badge('On a break', 'warning', 'pause') : badge('On the clock', 'success', 'clock'),
      h('span', { class: 'caption muted' }, `Started ${formatClock(Date.parse(shift.startedAt), tz())}`)),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('span', { class: 'stat__label' }, 'Time today'), h('span', { class: 'stat__value mono' }, hoursLabel(shift.timing.knockingMs))),
      h('div', { class: 'stat' }, h('span', { class: 'stat__label' }, 'Doors so far'), h('span', { class: 'stat__value mono' }, String(shift.doors || 0)))),
    h('div', { class: 'row', style: { gap: '10px' } },
      h('button', { type: 'button', class: 'btn btn--secondary grow', onclick: () => toggleBreak(shift) }, icon(onBreak ? 'play' : 'pause'), onBreak ? 'Back on the clock' : 'Take a break'),
      h('button', { type: 'button', class: 'btn btn--danger grow', onclick: async () => {
        const ok = await sheet('End shift?', close => [
          h('p', {}, `${shift.doors || 0} doors · ${hoursLabel(shift.timing.knockingMs)} knocking today. Ending stops the knocking clock.`),
          h('button', { type: 'button', class: 'btn btn--danger btn--block', onclick: () => close(true) }, 'End shift'),
          h('button', { type: 'button', class: 'btn btn--quiet btn--block', onclick: () => close(false) }, 'Keep going'),
        ]);
        if (ok) await endShift(shift);
      } }, 'End shift')),
    onKnock ? null : h('a', { class: 'btn btn--primary btn--xl btn--block', href: '#knock' }, 'Keep knocking'));
}

/* ---------- logging a door ---------- */

async function logDoor(house, outcome, details = {}) {
  const shift = app.currentShift();
  if (!shift) return toast('Start a shift first.', { tone: 'bad' });
  if (shift.timing.onBreak) return toast('You\'re on a break', { tone: 'bad', sub: 'Tap Back on the clock to log doors.' });
  const window = app.knockingWindow(house);
  const today = zonedDate(Date.now());
  const finishing = window.phase === 'grace' && S().ui.graceDoorFor !== today;
  const allowed = doorAllowed(window, { finishingDoor: finishing });
  if (!allowed.allowed) return toast(window.phase === 'before' ? `Knocking opens at ${window.startLabel}.` : 'Sunset has passed. New doors are closed for today.', { tone: 'bad' });
  const prev = app.houseView(house.id).summary;
  const carOutside = Boolean(S().ui.carOutside);
  const event = await app.enqueue('knock', {
    shiftId: shift.id, houseId: house.id, outcome, carOutside,
    ...(details.quotedAmount != null ? { quotedAmount: details.quotedAmount } : {}),
    ...(details.comeBackAt ? { comeBackAt: details.comeBackAt } : {}),
    ...(details.note ? { note: details.note } : {}),
    ...(allowed.afterEnd ? { afterEnd: true } : {}),
    ...(S().position && Date.now() - S().position.at < 120000 ? { lat: S().position.lat, lng: S().position.lng, accuracy: Math.round(S().position.accuracy) } : {}),
  });
  if (details.note) await rememberNote(house.id, details.note);
  const lastAction = { eventId: event.id, houseId: house.id, outcome, prev, knock: { at: event.at, shiftId: shift.id, carOutside, quotedAmount: details.quotedAmount ?? null, comeBackAt: details.comeBackAt ?? null, note: details.note ?? null } };
  const next = nextOnStreet(houseEntries({ neighborhoodId: house.n }).map(e => ({ house: e.house, status: e.status })), house, S().ui.previousNumber);
  await app.saveUi({ lastAction, carOutside: false, ...(allowed.afterEnd ? { graceDoorFor: today } : {}) });
  if (next) await selectHouse(next.house, { previousNumber: house.number });
  toast(`Saved: ${OUTCOME_LABELS[outcome]}`, { sub: `${houseLabel(house)}${S().online ? '' : ' · saved on this phone'}`, action: { label: 'Undo', run: undoLast } });
  if (navigator.vibrate) navigator.vibrate(30);
  app.render();
  return event;
}

export async function undoLast() {
  const last = S().ui.lastAction;
  if (!last) return toast('Nothing to undo.');
  const outbox = app.outboxApi();
  const queued = (await outbox.list(S().viewer.user)).find(e => e.id === last.eventId && e.state === 'queued');
  if (last.outcome === 'sold') return toast('A sale can\'t be undone here', { tone: 'bad', sub: 'Ask an admin to cancel it.' });
  if (queued) {
    // Never sent: drop it from this phone entirely.
    await outbox.remove(last.eventId);
  } else {
    await app.enqueue('knock.void', { target: last.eventId, houseId: last.houseId, _prev: last.prev });
  }
  await app.refreshPending();
  await app.saveUi({ lastAction: null, houseId: last.houseId });
  toast('Undone', { sub: houseLabel(S().houses.get(last.houseId) || { number: '', street: '' }), iconName: 'comeBack' });
  app.render();
}

async function editLast() {
  const last = S().ui.lastAction;
  if (!last) return;
  if (last.outcome === 'sold') return toast('A sale can\'t be changed here', { tone: 'bad', sub: 'Ask an admin.' });
  const house = S().houses.get(last.houseId);
  const choice = await sheet('Change the last door', close => {
    let car = Boolean(last.knock.carOutside);
    return [
      h('label', { class: 'toggle' }, h('span', { class: 'row', style: { gap: '10px' } }, icon('car'), 'Car parked outside the garage'),
        h('input', { type: 'checkbox', checked: car, onchange: e => { car = e.target.checked; } }), h('span', { class: 'toggle__switch', 'aria-hidden': 'true' })),
      h('div', { class: 'outcomes' }, OUTCOME_ORDER.filter(o => o !== 'sold').map(outcome => outcomeButton(outcome, { onclick: () => close({ outcome, carOutside: car }) }))),
    ];
  }, { subtitle: house ? houseLabel(house) : '' });
  if (!choice) return;
  let details = {};
  if (choice.outcome === 'come_back') { details = await comeBackSheet(house); if (!details) return; }
  if (choice.outcome === 'look') { details = await lookSheet(house); if (!details) return; }
  const outbox = app.outboxApi();
  const queued = (await outbox.list(S().viewer.user)).find(e => e.id === last.eventId && e.state === 'queued');
  const fields = { outcome: choice.outcome, carOutside: choice.carOutside, quotedAmount: details.quotedAmount ?? null, comeBackAt: details.comeBackAt ?? null, note: details.note ?? null };
  if (queued) {
    await outbox.amend(last.eventId, row => {
      const next = { ...row, outcome: fields.outcome, carOutside: fields.carOutside };
      for (const key of ['quotedAmount', 'comeBackAt', 'note']) { if (fields[key] == null) delete next[key]; else next[key] = fields[key]; }
      return next;
    });
  } else {
    await app.enqueue('knock.edit', { target: last.eventId, houseId: last.houseId, ...fields, _prev: last.prev, _knock: last.knock });
  }
  if (details.note) await rememberNote(last.houseId, details.note);
  await app.refreshPending();
  await app.saveUi({ lastAction: { ...last, outcome: choice.outcome, knock: { ...last.knock, ...fields } } });
  toast(`Changed to ${OUTCOME_LABELS[choice.outcome]}`, { sub: house ? houseLabel(house) : '' });
  app.render();
}

const TIME_OF_DAY = { morning: ['Morning', '10:00'], afternoon: ['Afternoon', '14:00'], evening: ['Evening', '17:30'] };

function comeBackSheet(house) {
  const zone = tz();
  const today = zonedDate(Date.now(), zone);
  const tomorrow = addDays(today, 1);
  const day = weekday(today);
  const weekendDay = day === 6 ? addDays(today, 1) : day === 0 ? addDays(today, 6) : addDays(today, 6 - day);
  const left = house ? app.houseView(house.id)?.status?.attemptsLeft : null;
  return sheet('Come back', close => {
    let time = 'evening';
    const date = h('input', { class: 'input', type: 'date', value: tomorrow, min: today, 'aria-label': 'Come back on' });
    const dateField = h('div', { class: 'field', hidden: true }, h('label', { class: 'label', for: 'cb-date' }, 'Which day?'), date);
    date.id = 'cb-date';
    const when = choiceGroup([
      ['tonight', 'This evening', 'after 5 pm'], ['tomorrow', 'Tomorrow', dateLabel(tomorrow)],
      ['weekend', 'This weekend', 'Sat or Sun'], ['pick', 'Pick a day', 'calendar'],
    ], 'tonight', value => {
      dateField.hidden = value !== 'pick';
      if (value === 'tonight') { time = 'evening'; mountTimes(); }
    });
    const times = h('div', {});
    const mountTimes = () => times.replaceChildren(seg(Object.entries(TIME_OF_DAY).map(([key, [label]]) => [key, label]), time, key => { time = key; mountTimes(); }, { label: 'Best time of day' }));
    mountTimes();
    const note = h('textarea', { class: 'input input--area', id: 'cb-note', maxlength: '480', placeholder: 'Who you talked to, what they said…' });
    const save = event => {
      event.preventDefault();
      const choice = when.value();
      const dayChosen = choice === 'tonight' ? today : choice === 'tomorrow' ? tomorrow : choice === 'weekend' ? weekendDay : (date.value || tomorrow);
      let at = zonedInstant(dayChosen, TIME_OF_DAY[choice === 'tonight' ? 'evening' : time][1], zone);
      // Later tonight when it is already past 5:30.
      if (at != null && at < Date.now()) at = Math.ceil((Date.now() + 3600000) / 900000) * 900000;
      close({ comeBackAt: at == null ? undefined : new Date(at).toISOString(), note: note.value.trim() || undefined });
    };
    return h('form', { class: 'stack', style: { gap: '14px' }, onsubmit: save },
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'When?'), when.el),
      dateField,
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Best time of day'), times),
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'cb-note' }, 'Note ', h('span', { class: 'muted', style: { fontWeight: '400' } }, '(optional)')), note),
      h('button', { type: 'submit', class: 'btn btn--primary btn--xl btn--block' }, 'Save come-back'),
      h('button', { type: 'button', class: 'btn btn--quiet btn--block', onclick: () => close(null) }, 'Cancel'));
  }, { dot: 'come_back', subtitle: `${house ? houseLabel(house) : ''}${left != null ? ` · ${left} ${left === 1 ? 'try' : 'tries'} left this season` : ''}` });
}

function lookSheet(house) {
  const quoted = house ? app.houseView(house.id)?.summary?.quotedAmount : null;
  return sheet('They want a quote', close => {
    const amount = h('input', { class: 'input input--money', id: 'lk-price', type: 'text', inputmode: 'decimal', autocomplete: 'off', value: quoted ? String(quoted) : '' });
    const interest = choiceGroup(PACKAGES.map(pkg => [pkg, pkg]), '');
    const note = h('textarea', { class: 'input input--area', id: 'lk-note', maxlength: '440', placeholder: 'What\'s in the garage, what they want gone…' });
    const walkthrough = S().viewer?.walkthrough && S().settings.integrations.walkthroughUrl;
    const save = event => {
      event.preventDefault();
      const raw = amount.value.replace(/[$,\s]/g, '');
      const value = raw === '' ? null : Math.round(Number(raw));
      if (raw !== '' && !(Number.isFinite(value) && value >= 0 && value <= 100000)) { amount.classList.add('input--error'); amount.focus(); return; }
      const text = [interest.value() ? `Interested in ${interest.value()}.` : '', note.value.trim()].filter(Boolean).join(' ');
      close({ quotedAmount: value, note: text || undefined });
    };
    return h('form', { class: 'stack', style: { gap: '14px' }, onsubmit: save },
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'lk-price' }, 'Quoted price'), h('div', { class: 'money-field' }, h('span', {}, '$'), amount),
        h('span', { class: 'hint' }, 'Leave blank if you didn\'t quote yet.')),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'What are they thinking about?'), interest.el),
      h('div', { class: 'field' }, h('label', { class: 'label', for: 'lk-note' }, 'Note ', h('span', { class: 'muted', style: { fontWeight: '400' } }, '(optional)')), note),
      walkthrough ? h('a', { class: 'btn btn--secondary btn--block', style: { minHeight: '60px' }, target: '_blank', rel: 'noopener',
        href: `${S().settings.integrations.walkthroughUrl}?address=${encodeURIComponent(houseLabel(house))}&source=knock&houseId=${encodeURIComponent(house.id)}` }, icon('home'), 'Start in-home walkthrough') : null,
      walkthrough ? h('span', { class: 'hint center', style: { marginTop: '-6px' } }, 'Owners only') : null,
      h('button', { type: 'submit', class: 'btn btn--primary btn--xl btn--block' }, 'Save look'),
      h('button', { type: 'button', class: 'btn btn--quiet btn--block', onclick: () => close(null) }, 'Cancel'));
  }, { dot: 'look', subtitle: house ? houseLabel(house) : '' });
}

async function tapOutcome(house, outcome, button) {
  button?.classList.add('is-pressed');
  setTimeout(() => button?.classList.remove('is-pressed'), 150);
  if (outcome === 'come_back') {
    const details = await comeBackSheet(house);
    if (details) await logDoor(house, outcome, details);
    return;
  }
  if (outcome === 'look') {
    const details = await lookSheet(house);
    if (details) await logDoor(house, outcome, details);
    return;
  }
  if (outcome === 'sold') {
    if (!app.saleForm) return toast('Sales open in the next update.', { tone: 'bad' });
    return app.saleForm(house, details => logDoor(house, 'sold', details));
  }
  await logDoor(house, outcome);
}

function outcomeButton(outcome, attrs = {}) {
  const [cls, glyph, label, small] = OUTCOME_BUTTONS[outcome];
  return h('button', { type: 'button', class: `oc oc--${cls}`, 'data-outcome': outcome, 'aria-label': small ? `${label}, ${small}` : label, ...attrs },
    h('span', { class: 'oc__disc' }, icon(glyph)),
    h('span', { class: 'oc__label' }, label, small ? h('small', {}, small) : null));
}

/* ---------- knock screen ---------- */

function windowBanner(house, shift) {
  const window = app.knockingWindow(house);
  if (shift?.timing.onBreak) {
    return banner('warn', 'pause', 'You\'re on a break', 'Outcomes are off until you\'re back.',
      h('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: () => toggleBreak(shift) }, 'Back on the clock'));
  }
  if (window.phase === 'before') {
    const minutes = Math.max(1, Math.ceil((window.startAt - Date.now()) / 60000));
    return banner('info', 'clock', `Knocking opens at ${window.startLabel}`, `You can look at your list and map now. Doors unlock in ${minutes < 90 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`}.`);
  }
  if (window.phase === 'grace') {
    return S().ui.graceDoorFor === zonedDate(Date.now())
      ? banner('error', 'ban', 'Closed for the day', 'Sunset passed and your last door is logged. End your shift.')
      : banner('error', 'alert', 'Sun\'s down', `You can log only this door for the next ${Math.max(1, Math.ceil((window.graceEndAt - Date.now()) / 60000))} minutes. It'll be flagged for review.`);
  }
  if (window.phase === 'closed') {
    const shiftDoors = app.currentShift()?.doors;
    return banner('error', 'ban', 'Closed for the day', `Knocking is done until ${window.startLabel} tomorrow.${shiftDoors ? ` Nice work today: ${shiftDoors} doors.` : ''}`);
  }
  if (window.warning) return banner('warn', 'alert', `${Math.ceil(window.msToEnd / 60000)} minutes to sunset`, `Finish the door you're at. New doors close at ${window.endLabel}.`);
  return null;
}

function knockScreen() {
  startWatchingPosition();
  const shift = app.currentShift();
  if (!shift) {
    return h('div', { class: 'screen' },
      h('h1', {}, 'Ready to knock?'),
      h('p', { class: 'muted' }, 'Start your shift and the nearest house you haven\'t knocked comes up first.'),
      shiftCard());
  }
  let house = currentHouse();
  if (!house || !S().houses.has(house.id)) {
    house = suggestedHouse();
    if (house) app.saveUi({ houseId: house.id, pickedWithoutGps: !S().position });
  }
  if (!house) {
    return h('div', { class: 'screen' }, shiftCard({ onKnock: true }),
      emptyState('door', 'No houses to knock', 'Your territory has nothing knockable on this phone yet. Sync, or ask your lead for more streets.',
        h('button', { type: 'button', class: 'btn btn--primary', onclick: () => app.sync({ full: true }) }, icon('refresh'), 'Sync now')));
  }
  const view = app.houseView(house.id);
  const entry = { house, summary: view.summary, status: view.status };
  const nbhd = app.neighborhoodOf(house);
  const window = app.knockingWindow(house);
  const finishing = window.phase === 'grace' && S().ui.graceDoorFor !== zonedDate(Date.now());
  const canLog = view.status.knockable && !shift.timing.onBreak && (window.phase === 'open' || finishing);
  const last = S().ui.lastAction;
  const lastHouse = last ? S().houses.get(last.houseId) : null;
  const inNeighborhood = houseEntries({ neighborhoodId: house.n }).sort(byAddress);
  const position = inNeighborhood.findIndex(e => e.house.id === house.id) + 1;
  const siblings = inNeighborhood.filter(e => e.house.street === house.street);
  const near = nearestSuggestion(houseEntries().filter(e => e.status.knockable && e.house.id !== house.id), S().position);
  const last1 = lastOutcomeLine(view.summary);
  const note = myNote(house.id);
  return h('div', { class: 'screen screen--fill' },
    windowBanner(house, shift),
    h('section', { class: 'house', 'aria-label': 'Current house' },
      h('div', { class: 'row row--between' }, badge(nbhd?.name || 'Territory', 'navy'), h('span', { class: 'caption muted' }, `House ${position} of ${inNeighborhood.length}`)),
      h('div', { class: 'house__addr' }, houseLabel(house)),
      h('div', { class: 'house__status' }, dot(dotKind(entry)), h('span', {}, statusText(entry)),
        finishing && canLog ? h('span', { style: { marginLeft: 'auto' } }, badge('Will be flagged', 'error')) : null),
      last1 || note ? h('div', { class: 'caption muted' }, [last1, note ? `“${note}”` : ''].filter(Boolean).join(' · ')) : null),
    h('label', { class: 'toggle' },
      h('span', { class: 'row', style: { gap: '10px' } }, icon('car'), 'Car parked outside the garage'),
      h('input', { type: 'checkbox', checked: Boolean(S().ui.carOutside), onchange: async e => { await app.saveUi({ carOutside: e.target.checked }); } }),
      h('span', { class: 'toggle__switch', 'aria-hidden': 'true' })),
    h('div', { class: 'row', style: { gap: '8px' } },
      h('button', { type: 'button', class: 'btn btn--quiet', style: { padding: '0 14px' }, 'aria-label': 'Previous house', onclick: () => step(house, siblings, -1) }, icon('arrowLeft')),
      near
        ? h('button', { type: 'button', class: 'btn btn--quiet btn--stack grow', onclick: async () => { await selectHouse(near.house); app.render(); } },
          h('span', { class: 'caption muted', style: { fontWeight: '400' } }, 'Nearest unknocked'), h('span', {}, `${houseLabel(near.house)} · ${distanceLabel(near.meters)}`))
        : h('a', { class: 'btn btn--quiet btn--stack grow', href: '#list' },
          h('span', { class: 'caption muted', style: { fontWeight: '400' } }, S().position ? 'Pick another house' : 'Location is off'), h('span', {}, 'Open the list')),
      h('button', { type: 'button', class: 'btn btn--quiet', style: { padding: '0 14px' }, 'aria-label': 'Next house', onclick: () => step(house, siblings, 1) }, icon('arrowRight'))),
    last && lastHouse ? h('div', { class: 'row row--between caption' },
      h('span', { class: 'muted' }, `Last: ${houseLabel(lastHouse)} · ${OUTCOME_LABELS[last.outcome]}`),
      h('span', { class: 'row', style: { gap: '14px' } }, h('button', { type: 'button', class: 'link caption', onclick: undoLast }, 'Undo'), h('button', { type: 'button', class: 'link caption', onclick: editLast }, 'Change'))) : null,
    h('div', { class: 'spacer' }),
    !view.status.knockable ? banner('', 'info', 'This house can\'t be knocked', statusText(entry)) : null,
    h('div', { class: 'outcomes', role: 'group', 'aria-label': 'Door outcome' }, OUTCOME_ORDER.map(outcome =>
      outcomeButton(outcome, { disabled: !canLog, onclick: event => tapOutcome(house, outcome, event.currentTarget) }))));
}

async function step(house, siblings, direction) {
  const sorted = siblings.map(e => e.house).sort((a, b) => Number.parseInt(a.number, 10) - Number.parseInt(b.number, 10));
  const index = sorted.findIndex(x => x.id === house.id);
  const next = sorted[(index + direction + sorted.length) % sorted.length];
  if (next) { await selectHouse(next, { previousNumber: house.number }); app.render(); }
}

/* ---------- list screen ---------- */

const FILTERS = [['todo', 'To knock'], ['goback', 'Go-backs'], ['done', 'Done'], ['all', 'All']];

function listRowSub(entry, { nearestId, nearestMeters, currentId }) {
  const parts = [statusText(entry)];
  const summary = entry.summary || {};
  if (entry.status.status === 'go_back' && summary.lastOutcome === 'no_answer' && summary.lastAt) {
    parts.splice(0, 1, `No answer · ${whenLabel(summary.lastAt)}`);
  }
  if (entry.house.id === currentId) parts.push('you\'re here');
  else if (entry.house.id === nearestId) parts.push(`nearest to you, ${distanceLabel(nearestMeters)}`);
  const note = myNote(entry.house.id);
  if (note && entry.status.status === 'go_back') parts.push(`“${note}”`);
  return parts.join(' · ');
}

async function pickNeighborhood(current) {
  const unlocked = S().territory.neighborhoods.filter(n => !n.locked);
  const picked = await sheet('Neighborhood', close => h('div', { class: 'list list--boxed' }, unlocked.map(n =>
    h('button', { type: 'button', class: `list-row${n.id === current ? ' list-row--now' : ''}`, onclick: () => close(n.id) },
      h('span', { class: 'list-row__main' }, h('span', { class: 'list-row__title' }, n.name)),
      n.tier === 'Premium' ? badge('Premium', 'navy') : badge(n.tier || 'Volume'), icon('chevronRight')))));
  if (picked) { await app.saveUi({ listNeighborhood: picked }); app.go('list', { n: picked, f: S().ui.listFilter || 'todo' }); }
}

function listScreen(_app, params) {
  const unlocked = S().territory.neighborhoods.filter(n => !n.locked);
  const nbhdId = params.get('n') || S().ui.listNeighborhood || unlocked[0]?.id || '';
  const nbhd = unlocked.find(n => n.id === nbhdId) || unlocked[0];
  if (!nbhd) return h('div', { class: 'screen' }, emptyState('list', 'Nothing assigned yet', 'Ask your lead for a neighborhood. Its houses show up here.'));
  const filter = params.get('f') || S().ui.listFilter || 'todo';
  const all = houseEntries({ neighborhoodId: nbhd.id });
  const entries = all.filter(e => filter === 'all' ? true : filter === 'todo' ? e.status.knockable : filter === 'goback' ? e.status.status === 'go_back' : !e.status.knockable).sort(byAddress);
  const streets = new Map();
  for (const e of entries) {
    if (!streets.has(e.house.street)) streets.set(e.house.street, []);
    streets.get(e.house.street).push(e);
  }
  const knocked = all.filter(e => e.summary?.lastOutcome).length;
  const near = nearestSuggestion(all.filter(e => e.status.knockable), S().position);
  const context = { nearestId: near?.house.id, nearestMeters: near?.meters, currentId: app.currentShift() ? S().ui.houseId : null };
  const setFilter = async key => { await app.saveUi({ listFilter: key }); app.go('list', { n: nbhd.id, f: key }); };
  return h('div', { class: 'screen screen--flush' },
    h('div', { class: 'panel' },
      h('div', { class: 'row row--between' },
        unlocked.length > 1
          ? h('button', { type: 'button', class: 'link row', style: { gap: '6px', textDecoration: 'none' }, 'aria-label': `Neighborhood: ${nbhd.name}. Change`, onclick: () => pickNeighborhood(nbhd.id) },
            h('h1', { style: { fontSize: '24px' } }, nbhd.name), icon('chevronDown'))
          : h('h1', { style: { fontSize: '24px' } }, nbhd.name),
        nbhd.tier === 'Premium' ? badge('Premium', 'navy') : badge(nbhd.tier || 'Volume')),
      h('div', { class: 'meter' },
        h('div', { class: 'meter__top' }, h('span', {}, `${knocked} of ${all.length} houses knocked`), h('span', { class: 'muted' }, `${all.length ? Math.floor(knocked / all.length * 100) : 0}%`)),
        h('div', { class: 'meter__bar' }, h('div', { class: 'meter__fill meter__fill--orange', style: { width: `${all.length ? knocked / all.length * 100 : 0}%` } }))),
      seg(FILTERS, filter, setFilter, { label: 'Filter' })),
    entries.length ? h('div', { class: 'list' }, [...streets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([street, rows]) => [
      h('div', { class: 'list-head' }, `${titleStreet(street)} · ${rows.length} house${rows.length === 1 ? '' : 's'}`),
      rows.map(e => {
        const now = e.house.id === context.currentId;
        const open = e.status.knockable;
        return h(open ? 'a' : 'button', {
          class: `list-row${now ? ' list-row--now' : ''}`, ...(open ? { href: '#knock' } : { type: 'button' }),
          onclick: async event => { event.preventDefault(); await selectHouse(e.house); app.go('knock'); },
        },
        dot(dotKind(e), { large: true }),
        h('span', { class: 'list-row__main' }, h('span', { class: 'list-row__title' }, houseLabel(e.house)), h('span', { class: 'list-row__sub' }, listRowSub(e, context))),
        now ? badge('Now', 'orange') : open ? icon('chevronRight') : null);
      }),
    ])) : h('div', { class: 'screen' }, emptyState(filter === 'goback' ? 'comeBack' : 'check',
      filter === 'todo' ? 'Nothing left to knock here' : filter === 'goback' ? 'No go-backs yet' : 'Nothing here yet',
      filter === 'goback' ? 'When you tap Come back or No answer on a door, it shows up here.' : 'Try another filter or neighborhood.')));
}

/* ---------- go-backs ---------- */

function bucketOf(minutes) {
  const buckets = S().settings.goBacks.buckets || [];
  const toMinutes = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return buckets.find(b => minutes >= toMinutes(b.start) && minutes < toMinutes(b.end)) || null;
}

function goBacksScreen() {
  const zone = tz();
  const nowParts = zonedParts(Date.now(), zone);
  const today = nowParts.date;
  const currentBucket = bucketOf(nowParts.minutes);
  const buckets = S().settings.goBacks.buckets || [];
  const order = new Map(buckets.map((b, i) => [b.key, i]));
  const all = houseEntries();
  const backs = all.filter(e => e.status.status === 'go_back');
  const resting = all.filter(e => e.status.status === 'resting');
  const groups = { now: [], later: [], another: [] };
  for (const e of backs) {
    const tip = goBackSuggestion(e.summary, { ...S().settings, timeZone: zone });
    let group = 'another';
    if (tip.kind === 'requested') {
      const at = Date.parse(tip.at), date = zonedDate(at, zone);
      group = at <= Date.now() + 3600000 && date <= today ? 'now' : date === today ? 'later' : 'another';
    } else if (tip.kind === 'bucket') {
      const index = order.get(tip.bucket), current = currentBucket ? order.get(currentBucket.key) : -1;
      group = index === current ? 'now' : index > current ? 'later' : 'another';
    } else group = 'now';
    groups[group].push({ e, tip });
  }
  const distance = e => (S().position ? Math.round(Math.hypot((e.house.lat - S().position.lat) * 111320, (e.house.lng - S().position.lng) * 111320 * Math.cos(S().position.lat * Math.PI / 180))) : null);
  const row = ({ e, tip }) => {
    const meters = distance(e);
    const note = myNote(e.house.id);
    const parts = [tip.kind === 'requested' ? `Back ${whenLabel(tip.at)}` : tip.kind === 'bucket' ? `Try ${bucketLabel(tip.bucket)}` : 'Any time',
      e.summary.lastOutcome === 'no_answer' && e.summary.lastAt ? `no answer ${whenLabel(e.summary.lastAt)}` : '',
      note ? `“${note}”` : '', meters != null ? `${distanceLabel(meters)} away` : ''];
    return h('a', { class: 'list-row', href: '#knock', onclick: async event => { event.preventDefault(); await selectHouse(e.house); app.go('knock'); } },
      dot(dotKind(e), { large: true }),
      h('span', { class: 'list-row__main' }, h('span', { class: 'list-row__title' }, houseLabel(e.house)), h('span', { class: 'list-row__sub' }, parts.filter(Boolean).join(' · '))),
      badge(`${e.status.attemptsLeft} left`, e.status.attemptsLeft === 1 ? 'warning' : ''));
  };
  const sortRows = list => list.sort((a, b) => (distance(a.e) ?? 0) - (distance(b.e) ?? 0) || byAddress(a.e, b.e));
  const head = (text, list) => (list.length ? [h('div', { class: 'list-head' }, text), sortRows(list).map(row)] : null);
  const nowLabel = currentBucket ? currentBucket.label.toLowerCase() : 'now';
  return h('div', { class: 'screen screen--flush' },
    h('div', { class: 'panel', style: { gap: '6px' } },
      h('div', { class: 'row row--between' }, h('span', { class: 'lead bold' }, `${backs.length} house${backs.length === 1 ? '' : 's'} to try again`), badge(`It's ${formatClock(Date.now(), zone)}`, 'info')),
      h('p', { class: 'caption muted' }, `${S().settings.goBacks.maxAttemptsPerSeason} tries per house each season. "Not interested" rests for ${S().settings.goBacks.notInterestedRestMonths ?? 6} months.`)),
    backs.length || resting.length ? h('div', { class: 'list' },
      head(`Good to try now · ${nowLabel}`, groups.now),
      head('Later today', groups.later),
      head('Another day', groups.another),
      resting.length ? [h('div', { class: 'list-head' }, 'Resting · not interested'), resting.sort(byAddress).map(e => h('div', { class: 'list-row list-row--static' },
        dot('not_interested', { large: true }),
        h('span', { class: 'list-row__main' }, h('span', { class: 'list-row__title muted' }, houseLabel(e.house)), h('span', { class: 'list-row__sub' }, `Rests until ${new Date(e.status.restUntil).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`))))] : null)
      : h('div', { class: 'screen' }, emptyState('home', 'No go-backs yet', 'When you tap Come back or No answer on a door, it shows up here.', h('a', { class: 'btn btn--primary', href: '#knock' }, 'Go knock'))));
}

export function install(appApi) {
  app = appApi;
  app.registerScreen('knock', knockScreen, { tab: { label: 'Knock', icon: 'door', order: 10 } });
  app.registerScreen('list', listScreen, { tab: { label: 'List', icon: 'list', order: 20 } });
  app.registerScreen('gobacks', goBacksScreen, { title: 'Go-backs', back: 'more' });
  app.shiftCard = shiftCard;
  app.moreLinks.push({ route: 'gobacks', label: 'Go-backs', icon: 'comeBack', order: 10,
    hint: () => { const n = houseEntries().filter(e => e.status.status === 'go_back').length; return n ? `${n} house${n === 1 ? '' : 's'} to try again` : 'Houses to try again'; } });
}

export { houseEntries, colorFor, dotKind, statusText, selectHouse, money, PACKAGES, shiftTiming };
