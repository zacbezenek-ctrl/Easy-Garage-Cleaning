/* Rep screens: shift clock, one-tap door logging, list view, go-backs and the sale form.
   Every tap is an append-only event queued on the phone and synced in the background. */
import { h, mount, toast, sheet, money, hoursLabel, timeLabel, dateLabel } from './knock-ui.js';
import { OUTCOME_LABELS, PACKAGES } from './knock-settings.js';
import { OUTCOME_COLORS, goBackSuggestion, houseLabel, nearestSuggestion, nextOnStreet, titleStreet } from './knock-doors.js';
import { doorAllowed, formatClock, zonedDate, zonedInstant, addDays } from './knock-time.js';
import { shiftTiming } from './knock-stats.js';

let app;
let watchId = null;

const OUTCOME_ORDER = ['no_answer', 'not_interested', 'come_back', 'look', 'sold', 'skipped_sign'];
const S = () => app.S;

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

function colorFor(entry) {
  if (entry.status.status === 'blocked') return OUTCOME_COLORS.blocked;
  return OUTCOME_COLORS[entry.summary?.lastOutcome || 'none'] || OUTCOME_COLORS.none;
}

function statusText(entry) {
  const st = entry.status;
  if (st.status === 'go_back') {
    const tip = goBackSuggestion(entry.summary, S().settings);
    return `Go-back · ${st.attemptsLeft} left · ${tip.kind === 'requested' ? `asked for ${timeLabel(tip.at)}` : tip.label}`;
  }
  if (st.status === 'resting') return `Not interested · rests until ${new Date(st.restUntil).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
  if (st.status === 'new') return 'Not knocked yet';
  if (st.status === 'rested') return 'Rest period over · knock again';
  return st.reason || st.status;
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
  const sorted = entries.sort((a, b) => a.house.street.localeCompare(b.house.street) || Number.parseInt(a.house.number, 10) - Number.parseInt(b.house.number, 10));
  return (sorted.find(e => e.status.status === 'new') || sorted[0]).house;
}

function currentHouse() {
  const id = S().ui.houseId;
  return (id && S().houses.get(id)) || null;
}

async function selectHouse(house, { previousNumber = null } = {}) {
  await app.saveUi({ houseId: house?.id || null, previousNumber, pickedWithoutGps: false });
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
  toast('Shift started. Knock safe and friendly.');
  app.go('knock');
}

async function toggleBreak(shift) {
  const open = (shift.breaks || []).find(b => !b.endAt);
  await app.enqueue(open ? 'shift.break_end' : 'shift.break_start', { shiftId: shift.id });
  toast(open ? 'Back on the clock.' : 'On break. Knocking time is paused.');
  app.render();
}

async function endShift(shift) {
  await app.enqueue('shift.end', { shiftId: shift.id, reason: 'manual' });
  toast(`Shift ended. ${shift.doors || 0} doors, ${hoursLabel(shift.timing.knockingMs)} knocking.`);
  app.go('home');
}

export function shiftCard() {
  const shift = app.currentShift();
  const window = app.knockingWindow();
  if (!shift) {
    return h('section', { class: 'card accent' },
      h('h2', {}, 'Start knocking'),
      h('p', { class: 'muted' }, window.phase === 'open' ? `You can knock until ${window.endLabel} (sunset).` : window.phase === 'before' ? `Knocking opens at ${window.startLabel}.` : `Sunset was ${window.endLabel}.`),
      S().eligibility.ok ? null : h('p', { class: 'notice' }, S().eligibility.reason),
      h('button', { type: 'button', class: 'primary wide', disabled: !S().eligibility.ok || window.phase !== 'open', onclick: startShift }, 'Start shift'));
  }
  const onBreak = shift.timing.onBreak;
  return h('section', { class: 'card accent' },
    h('div', { class: 'row spread' }, h('h2', {}, onBreak ? 'On break' : 'Shift running'), h('span', { class: 'badge ok' }, `since ${formatClock(Date.parse(shift.startedAt))}`)),
    h('div', { class: 'stats' },
      h('div', { class: 'stat' }, h('b', {}, hoursLabel(shift.timing.knockingMs)), h('span', {}, 'knocking')),
      h('div', { class: 'stat' }, h('b', {}, String(shift.doors || 0)), h('span', {}, 'doors')),
      h('div', { class: 'stat' }, h('b', {}, shift.timing.knockingMs > 0 ? ((shift.doors || 0) / (shift.timing.knockingMs / 3600000)).toFixed(1) : '0'), h('span', {}, 'doors / hour'))),
    h('div', { class: 'grid2', style: { marginTop: '.6rem' } },
      h('button', { type: 'button', onclick: () => toggleBreak(shift) }, onBreak ? 'End break' : 'Take a break'),
      h('button', { type: 'button', class: 'danger', onclick: async () => {
        const ok = await sheet('End shift?', close => h('div', {}, h('p', {}, 'Ending stops the knocking clock for today.'), h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', onclick: () => close(true) }, 'End shift'), h('button', { type: 'button', onclick: () => close(false) }, 'Keep going'))));
        if (ok) await endShift(shift);
      } }, 'End shift')));
}

/* ---------- logging a door ---------- */

async function logDoor(house, outcome, details = {}) {
  const shift = app.currentShift();
  if (!shift) return toast('Start a shift first.', { tone: 'bad' });
  if (shift.timing.onBreak) return toast('You are on break. End the break to log doors.', { tone: 'bad' });
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
    ...(allowed.afterEnd ? { afterEnd: true } : {}),
    ...(S().position && Date.now() - S().position.at < 120000 ? { lat: S().position.lat, lng: S().position.lng, accuracy: Math.round(S().position.accuracy) } : {}),
  });
  const lastAction = { eventId: event.id, houseId: house.id, outcome, prev, knock: { at: event.at, shiftId: shift.id, carOutside, quotedAmount: details.quotedAmount ?? null, comeBackAt: details.comeBackAt ?? null } };
  const next = nextOnStreet(houseEntries({ neighborhoodId: house.n }).map(e => ({ house: e.house, status: e.status })), house, S().ui.previousNumber);
  await app.saveUi({ lastAction, carOutside: false, ...(allowed.afterEnd ? { graceDoorFor: today } : {}) });
  if (next) await selectHouse(next.house, { previousNumber: house.number });
  toast(`${OUTCOME_LABELS[outcome]} · ${houseLabel(house)}`, { action: { label: 'Undo', run: undoLast } });
  if (navigator.vibrate) navigator.vibrate(30);
  app.render();
  return event;
}

export async function undoLast() {
  const last = S().ui.lastAction;
  if (!last) return toast('Nothing to undo.');
  const outbox = app.outboxApi();
  const queued = (await outbox.list(S().viewer.user)).find(e => e.id === last.eventId && e.state === 'queued');
  if (last.outcome === 'sold') return toast('A sale cannot be undone here. Ask an admin to cancel it.', { tone: 'bad' });
  if (queued) {
    // Never sent: drop it from this phone entirely.
    await outbox.remove(last.eventId);
  } else {
    await app.enqueue('knock.void', { target: last.eventId, houseId: last.houseId, _prev: last.prev });
  }
  await app.refreshPending();
  await app.saveUi({ lastAction: null, houseId: last.houseId });
  toast('Undone.');
  app.render();
}

async function editLast() {
  const last = S().ui.lastAction;
  if (!last) return;
  if (last.outcome === 'sold') return toast('A sale cannot be edited here. Ask an admin.', { tone: 'bad' });
  const choice = await sheet('Change the last door', close => {
    let car = Boolean(last.knock.carOutside);
    return h('div', { class: 'stack' },
      h('p', { class: 'muted' }, houseLabel(S().houses.get(last.houseId) || { number: '', street: '' })),
      h('label', { class: 'toggle' }, 'Car parked outside', h('input', { type: 'checkbox', checked: car, onchange: e => { car = e.target.checked; } })),
      h('div', { class: 'outcomes' }, OUTCOME_ORDER.filter(o => o !== 'sold').map(outcome =>
        h('button', { type: 'button', class: 'outcome', onclick: () => close({ outcome, carOutside: car }) }, h('span', { class: 'dot', style: { background: OUTCOME_COLORS[outcome === 'skipped_sign' ? 'blocked' : outcome] } }), OUTCOME_LABELS[outcome]))));
  });
  if (!choice) return;
  const house = S().houses.get(last.houseId);
  let details = {};
  if (choice.outcome === 'come_back') details = await comeBackSheet() || {};
  if (choice.outcome === 'look') details = await lookSheet(house) || {};
  const outbox = app.outboxApi();
  const queued = (await outbox.list(S().viewer.user)).find(e => e.id === last.eventId && e.state === 'queued');
  const fields = { outcome: choice.outcome, carOutside: choice.carOutside, quotedAmount: details.quotedAmount ?? null, comeBackAt: details.comeBackAt ?? null };
  if (queued) {
    await outbox.amend(last.eventId, row => {
      const next = { ...row, outcome: fields.outcome, carOutside: fields.carOutside };
      for (const key of ['quotedAmount', 'comeBackAt']) { if (fields[key] == null) delete next[key]; else next[key] = fields[key]; }
      return next;
    });
  } else {
    await app.enqueue('knock.edit', { target: last.eventId, houseId: last.houseId, ...fields, _prev: last.prev, _knock: last.knock });
  }
  await app.refreshPending();
  await app.saveUi({ lastAction: { ...last, outcome: choice.outcome, knock: { ...last.knock, ...fields } } });
  toast(`Changed to ${OUTCOME_LABELS[choice.outcome]}.`);
  app.render();
}

function comeBackSheet() {
  const today = zonedDate(Date.now());
  const at = (date, time) => new Date(zonedInstant(date, time)).toISOString();
  return sheet('Come back when?', close => {
    const date = h('input', { type: 'date', value: addDays(today, 1), min: today, 'aria-label': 'Come back date' });
    const time = h('input', { type: 'time', value: '17:30', 'aria-label': 'Come back time' });
    return h('div', { class: 'stack' },
      h('button', { type: 'button', class: 'primary wide', onclick: () => close({}) }, 'No set time'),
      h('div', { class: 'grid2' },
        h('button', { type: 'button', onclick: () => close({ comeBackAt: at(today, '17:30') }) }, 'Today 5:30 pm'),
        h('button', { type: 'button', onclick: () => close({ comeBackAt: at(addDays(today, 1), '17:30') }) }, 'Tomorrow 5:30 pm')),
      h('label', {}, 'Pick a day and time'),
      h('div', { class: 'grid2' }, date, time),
      h('button', { type: 'button', onclick: () => close({ comeBackAt: at(date.value, time.value || '17:30') }) }, 'Save this time'));
  });
}

function lookSheet(house) {
  return sheet('Garage look', close => {
    const amount = h('input', { type: 'number', inputmode: 'decimal', min: '0', step: '1', placeholder: 'Quoted price (optional)', 'aria-label': 'Quoted price' });
    const walkthrough = S().viewer?.walkthrough && S().settings.integrations.walkthroughUrl;
    return h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'You did the free five-minute garage look and gave a price.'),
      amount,
      h('button', { type: 'button', class: 'primary wide', onclick: () => close({ quotedAmount: amount.value === '' ? null : Math.round(Number(amount.value)) }) }, 'Save look'),
      walkthrough ? h('a', { class: 'button wide', target: '_blank', rel: 'noopener', href: `${S().settings.integrations.walkthroughUrl}?address=${encodeURIComponent(houseLabel(house))}&source=knock&houseId=${encodeURIComponent(house.id)}` }, 'Open the walkthrough') : null);
  });
}

async function tapOutcome(house, outcome) {
  if (outcome === 'come_back') {
    const details = await comeBackSheet();
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

/* ---------- knock screen ---------- */

function windowBanner(house) {
  const window = app.knockingWindow(house);
  if (window.phase === 'before') return h('div', { class: 'window-banner before' }, `Knocking opens at ${window.startLabel}. Sunset today is ${window.endLabel}.`);
  if (window.phase === 'grace') return h('div', { class: 'window-banner closed' }, S().ui.graceDoorFor === zonedDate(Date.now()) ? 'Sunset passed. New doors are closed. End your shift.' : `Sunset passed at ${window.endLabel}. You can log the door you were at until ${formatClock(window.graceEndAt)}; it is flagged for the admin.`);
  if (window.phase === 'closed') return h('div', { class: 'window-banner closed' }, `Sunset was ${window.endLabel}. Doors are closed for today. End your shift.`);
  if (window.warning) return h('div', { class: 'window-banner warn', role: 'alert' }, `${Math.ceil(window.msToEnd / 60000)} minutes to sunset (${window.endLabel}). Finish up.`);
  return null;
}

function knockScreen() {
  startWatchingPosition();
  const shift = app.currentShift();
  if (!shift) return h('div', {}, shiftCard());
  let house = currentHouse();
  if (!house || !S().houses.has(house.id)) {
    house = suggestedHouse();
    if (house) app.saveUi({ houseId: house.id, pickedWithoutGps: !S().position });
  }
  if (!house) return h('div', {}, shiftCard(), h('section', { class: 'card' }, h('h2', {}, 'No houses to knock'), h('p', {}, 'Your assigned territory has no knockable houses on this phone yet. Sync, or ask an admin to assign more streets.'), h('button', { type: 'button', onclick: () => app.sync({ full: true }) }, 'Sync now')));
  const view = app.houseView(house.id);
  const entry = { house, summary: view.summary, status: view.status };
  const nbhd = app.neighborhoodOf(house);
  const window = app.knockingWindow(house);
  const finishing = window.phase === 'grace' && S().ui.graceDoorFor !== zonedDate(Date.now());
  const canLog = view.status.knockable && !shift.timing.onBreak && (window.phase === 'open' || finishing);
  const last = S().ui.lastAction;
  const lastHouse = last ? S().houses.get(last.houseId) : null;
  const siblings = houseEntries({ neighborhoodId: house.n }).filter(e => e.house.street === house.street);
  const near = nearestSuggestion(houseEntries().filter(e => e.status.knockable && e.house.id !== house.id), S().position);
  return h('div', {},
    windowBanner(house),
    h('section', { class: 'house-card' },
      h('div', { class: 'address' }, houseLabel(house)),
      h('div', { class: 'meta' },
        h('span', { class: 'badge' }, nbhd?.name || ''),
        h('span', { class: `badge ${view.status.knockable ? 'ok' : 'locked'}` }, statusText(entry)),
        view.summary?.lastOutcome ? h('span', { class: 'badge' }, `Last: ${OUTCOME_LABELS[view.summary.lastOutcome]} ${view.summary.lastAt ? dateLabel(zonedDate(view.summary.lastAt)) : ''}`) : null)),
    h('label', { class: `toggle${S().ui.carOutside ? ' on' : ''}` }, 'Car parked outside the garage',
      h('input', { type: 'checkbox', checked: Boolean(S().ui.carOutside), onchange: async e => { await app.saveUi({ carOutside: e.target.checked }); app.render(); } })),
    h('div', { class: 'outcomes', role: 'group', 'aria-label': 'Door outcome' }, OUTCOME_ORDER.map(outcome =>
      h('button', { type: 'button', class: `outcome ${outcome}`, disabled: !canLog, 'data-outcome': outcome, onclick: () => tapOutcome(house, outcome) },
        h('span', { class: 'dot', style: { background: OUTCOME_COLORS[outcome === 'skipped_sign' ? 'blocked' : outcome] } }), OUTCOME_LABELS[outcome]))),
    last && lastHouse ? h('div', { class: 'lastline' },
      h('span', {}, `Last: ${houseLabel(lastHouse)} · ${OUTCOME_LABELS[last.outcome]}`),
      h('span', { class: 'row' }, h('button', { type: 'button', onclick: undoLast }, 'Undo'), h('button', { type: 'button', onclick: editLast }, 'Edit'))) : null,
    h('div', { class: 'nav-row' },
      h('button', { type: 'button', onclick: () => step(house, siblings, -1) }, '‹ Prev'),
      h('button', { type: 'button', onclick: () => app.go('list') }, 'Pick house'),
      h('button', { type: 'button', onclick: () => step(house, siblings, 1) }, 'Next ›')),
    near ? h('p', { class: 'muted', style: { marginTop: '.6rem' } }, `Nearest unknocked: `, h('button', { type: 'button', class: 'ghost', onclick: async () => { await selectHouse(near.house); app.render(); } }, `${houseLabel(near.house)} (${Math.round(near.meters)} m)`)) : null,
    shiftCard());
}

async function step(house, siblings, direction) {
  const sorted = siblings.map(e => e.house).sort((a, b) => Number.parseInt(a.number, 10) - Number.parseInt(b.number, 10));
  const index = sorted.findIndex(x => x.id === house.id);
  const next = sorted[(index + direction + sorted.length) % sorted.length];
  if (next) { await selectHouse(next, { previousNumber: house.number }); app.render(); }
}

/* ---------- list screen ---------- */

const FILTERS = { todo: 'To knock', goback: 'Go-backs', done: 'Done', all: 'All' };

function listScreen(_app, params) {
  const unlocked = S().territory.neighborhoods.filter(n => !n.locked);
  const nbhdId = params.get('n') || S().ui.listNeighborhood || unlocked[0]?.id || '';
  const filter = params.get('f') || S().ui.listFilter || 'todo';
  const entries = houseEntries({ neighborhoodId: nbhdId }).filter(e =>
    filter === 'all' ? true : filter === 'todo' ? e.status.knockable : filter === 'goback' ? e.status.status === 'go_back' : !e.status.knockable);
  const streets = new Map();
  for (const e of entries) {
    if (!streets.has(e.house.street)) streets.set(e.house.street, []);
    streets.get(e.house.street).push(e);
  }
  const all = houseEntries({ neighborhoodId: nbhdId });
  const knocked = all.filter(e => e.summary?.lastOutcome).length;
  return h('div', {},
    unlocked.length > 1 ? h('select', { 'aria-label': 'Neighborhood', onchange: async e => { await app.saveUi({ listNeighborhood: e.target.value }); app.go('list', { n: e.target.value, f: filter }); } },
      unlocked.map(n => h('option', { value: n.id, selected: n.id === nbhdId }, n.name))) : h('h2', {}, unlocked[0]?.name || 'No open territory'),
    h('p', { class: 'muted' }, `${knocked} of ${all.length} houses knocked`),
    h('div', { class: 'filters' }, Object.entries(FILTERS).map(([key, label]) =>
      h('button', { type: 'button', 'aria-pressed': String(key === filter), onclick: async () => { await app.saveUi({ listFilter: key }); app.go('list', { n: nbhdId, f: key }); } }, label))),
    entries.length ? [...streets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([street, rows]) => h('div', {},
      h('div', { class: 'street-head' }, `${titleStreet(street)} · ${rows.length}`),
      h('ul', { class: 'list' }, rows.sort((a, b) => Number.parseInt(a.house.number, 10) - Number.parseInt(b.house.number, 10)).map(e => h('li', {},
        h('button', { type: 'button', class: 'item', onclick: async () => { await selectHouse(e.house); app.go('knock'); } },
          h('span', { class: 'chip', style: { background: colorFor(e) } }),
          h('span', { style: { flex: '1' } }, h('b', {}, houseLabel(e.house)), h('br', {}), h('span', { class: 'muted' }, statusText(e)))))))))
      : h('p', { class: 'muted' }, filter === 'todo' ? 'Nothing left to knock here.' : 'No houses match.'));
}

/* ---------- go-backs ---------- */

function goBacksScreen() {
  const entries = houseEntries().filter(e => e.status.status === 'go_back');
  const now = Date.now();
  entries.sort((a, b) => {
    const ta = a.summary.comeBackAt ? Math.abs(Date.parse(a.summary.comeBackAt) - now) : Infinity;
    const tb = b.summary.comeBackAt ? Math.abs(Date.parse(b.summary.comeBackAt) - now) : Infinity;
    return ta - tb || a.house.street.localeCompare(b.house.street);
  });
  return h('div', {},
    h('h1', {}, 'Go-backs'),
    h('p', { class: 'muted' }, `No answer or Come back. Up to ${S().settings.goBacks.maxAttemptsPerSeason} tries a season; try a different time of day.`),
    entries.length ? h('ul', { class: 'list' }, entries.map(e => {
      const tip = goBackSuggestion(e.summary, S().settings);
      return h('li', {}, h('button', { type: 'button', class: 'item', onclick: async () => { await selectHouse(e.house); app.go('knock'); } },
        h('span', { class: 'chip', style: { background: colorFor(e) } }),
        h('span', { style: { flex: '1' } }, h('b', {}, houseLabel(e.house)), h('br', {}),
          h('span', { class: 'muted' }, `${OUTCOME_LABELS[e.summary.lastOutcome]} · ${e.status.attemptsLeft} ${e.status.attemptsLeft === 1 ? 'try' : 'tries'} left · ${tip.kind === 'requested' ? `asked for ${timeLabel(tip.at)}` : tip.label}`))));
    })) : h('p', { class: 'muted' }, 'No go-backs right now.'));
}

/* ---------- more ---------- */

function moreScreen() {
  const links = [['gobacks', 'Go-backs', 'Houses to try again']];
  if (app.moreLinks) links.push(...app.moreLinks);
  return h('div', {},
    h('h1', {}, 'More'),
    h('ul', { class: 'list' }, links.map(([route, label, hint]) => h('li', {}, h('button', { type: 'button', class: 'item', onclick: () => app.go(route) }, h('span', { style: { flex: '1' } }, h('b', {}, label), h('br', {}), h('span', { class: 'muted' }, hint)))))));
}

export function install(appApi) {
  app = appApi;
  app.registerScreen('knock', knockScreen, { tab: { label: 'Knock', glyph: '✊', order: 10 } });
  app.registerScreen('list', listScreen, { tab: { label: 'List', glyph: '☰', order: 20 } });
  app.registerScreen('gobacks', goBacksScreen);
  app.registerScreen('more', moreScreen, { tab: { label: 'More', glyph: '⋯', order: 40 } });
  app.shiftCard = shiftCard;
}

export { houseEntries, colorFor, statusText, selectHouse, money, PACKAGES, shiftTiming };
