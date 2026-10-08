/* Small DOM helpers and the shared components of the EGC Knock design. No framework: h() builds
   elements, attributes starting with "on" bind events, everything else is set as an attribute. */

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === false || value == null) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'value') el.value = value;
    else if (key === 'checked') el.checked = Boolean(value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function mount(target, ...children) {
  target.replaceChildren();
  append(target, children);
  return target;
}

/* ---------- icons: 24px line icons from the design, drawn with SVG elements ---------- */

const P = d => ['path', { d }];
const C = (cx, cy, r) => ['circle', { cx, cy, r }];
const R = (x, y, width, height, rx) => ['rect', { x, y, width, height, rx }];
const ICONS = {
  alert: [P('M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z')],
  eye: [P('M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z'), C(12, 12, 3)],
  wifiOff: [P('M1 1l22 22M8.5 16.5a5 5 0 0 1 7 0M5 12.5a10 10 0 0 1 5.2-2.7M12 20h.01M16.7 9.8A10 10 0 0 1 19 12.5M1.4 9A15 15 0 0 1 8 5.3M12 5a15 15 0 0 1 10.6 4')],
  sun: [C(12, 12, 4), P('M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4')],
  check: [P('M5 12l5 5L20 7')],
  play: [P('M6 4l14 8-14 8z')],
  clock: [C(12, 12, 9), P('M12 7v5l3 2')],
  pause: [P('M8 5v14M16 5v14')],
  chevronRight: [P('M9 6l6 6-6 6')],
  chevronLeft: [P('M15 6l-6 6 6 6')],
  chevronDown: [P('M6 9l6 6 6-6')],
  lock: [R(4, 11, 16, 10, 2), P('M8 11V7a4 4 0 0 1 8 0v4')],
  home: [P('M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z')],
  door: [R(5, 3, 14, 18, 1), C(15, 12, 1)],
  list: [P('M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01')],
  map: [P('M1 6v16l7-4 8 4 7-4V2l-7 4-8-4z'), P('M8 2v16M16 6v16')],
  more: [C(5, 12, 1.5), C(12, 12, 1.5), C(19, 12, 1.5)],
  ban: [C(12, 12, 9), P('M5.6 5.6l12.8 12.8')],
  car: [P('M5 17h14M3 11l2-5h14l2 5v6H3z'), C(7, 17, 2), C(17, 17, 2)],
  arrowLeft: [P('M19 12H5M12 5l-7 7 7 7')],
  arrowRight: [P('M5 12h14M12 5l7 7-7 7')],
  bell: [P('M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0')],
  close: [P('M6 6l12 12M18 6L6 18')],
  comeBack: [P('M3 12a9 9 0 1 0 3-6.7L3 8'), P('M3 3v5h5')],
  dollar: [P('M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6')],
  info: [C(12, 12, 9), P('M12 11v5M12 8h.01')],
  crosshair: [C(12, 12, 3), P('M12 2v4M12 18v4M2 12h4M18 12h4')],
  cash: [R(2, 6, 20, 12, 2), C(12, 12, 3)],
  chart: [P('M4 20V10M10 20V4M16 20v-8M22 20H2')],
  refresh: [P('M21 12a9 9 0 1 1-2.6-6.4L21 8'), P('M21 3v5h-5')],
  user: [C(12, 8, 4), P('M4 21a8 8 0 0 1 16 0')],
  flag: [P('M4 22V4h12l-2 4 2 4H4')],
  settings: [C(12, 12, 3), P('M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1')],
  shield: [P('M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z')],
  download: [P('M12 3v12M6 11l6 6 6-6M4 21h16')],
  trophy: [P('M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z'), P('M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3')],
};

export function icon(name, { size = '', label = '' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', `ico${size ? ` ico--${size}` : ''}`);
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); } else svg.setAttribute('aria-hidden', 'true');
  for (const [tag, attrs] of ICONS[name] || []) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    svg.append(el);
  }
  return svg;
}

/* ---------- formatting ---------- */

export const money = (value, cents = false) => value == null || !Number.isFinite(Number(value)) ? '—'
  : Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });

export const percent = (value, digits = 0) => value == null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(digits)}%`;

export const number = (value, digits = 0) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(digits);

export function hoursLabel(ms) {
  const minutes = Math.round((ms || 0) / 60000);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

export function dateLabel(date) {
  if (!date) return '';
  const d = new Date(`${date}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function longDateLabel(date) {
  if (!date) return '';
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

const lowerAmPm = text => text.replace(/ |\s(?=[AP]M\b)/g, ' ').replace(/ AM\b/g, ' am').replace(/ PM\b/g, ' pm');

export function timeLabel(iso, timeZone = 'America/Denver') {
  if (!iso) return '';
  return lowerAmPm(new Date(iso).toLocaleString('en-US', { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
}

// "08:30" to "8:30 am".
export function wallTime(hhmm) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!match) return hhmm || '';
  const hour = Number(match[1]);
  return `${hour % 12 === 0 ? 12 : hour % 12}:${match[2]} ${hour >= 12 ? 'pm' : 'am'}`;
}

// "+19705550100" to "(970) 555-0100".
export function phoneLabel(value) {
  const digits = String(value || '').replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : String(value || '');
}

export function clockLabel(iso, timeZone = 'America/Denver') {
  if (!iso) return '';
  return lowerAmPm(new Date(iso).toLocaleTimeString('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }));
}

// Distances read as "31 m" up close and "1.8 km" farther away.
export function distanceLabel(meters) {
  return meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ---------- components ---------- */

// Door outcome to its dot style and letter (color is never the only signal).
export const OUTCOME_DOT = Object.freeze({
  none: ['none', ''], no_answer: ['noanswer', 'N'], come_back: ['comeback', 'C'], not_interested: ['notint', 'X'],
  look: ['look', 'L'], sold: ['sold', '$'], skipped_sign: ['skip', 'S'], blocked: ['skip', 'S'],
});

export function dot(kind = 'none', { large = false } = {}) {
  const [cls, letter] = OUTCOME_DOT[kind] || OUTCOME_DOT.none;
  return h('span', { class: `dot dot--${cls}${large ? ' dot--lg' : ''}`, 'aria-hidden': 'true' }, letter);
}

export function badge(text, tone = '', iconName = '') {
  return h('span', { class: `badge${tone ? ` badge--${tone}` : ''}` }, iconName ? icon(iconName, { size: 'sm' }) : null, text);
}

export function banner(tone, iconName, title, text = '', extra = null) {
  return h('div', { class: `banner${tone ? ` banner--${tone}` : ''}${extra ? ' banner--center' : ''}`, role: tone === 'error' || tone === 'warn' ? 'alert' : 'status' },
    iconName ? icon(iconName) : null,
    h('div', { class: 'grow' }, title, text ? h('p', {}, text) : null),
    extra);
}

export function kv(label, value, attrs = {}) {
  return h('div', { class: 'kv' }, h('span', {}, label), h('b', attrs, value));
}

export function stat(label, value, { sub = '', tone = '', small = false } = {}) {
  return h('div', { class: `stat${tone ? ` stat--${tone}` : ''}` },
    h('span', { class: 'stat__label' }, label),
    h('span', { class: `stat__value${small ? ' stat__value--sm' : ''}` }, value),
    sub ? h('span', { class: 'stat__sub' }, sub) : null);
}

export function meter({ label = null, value = null, ratio = 0, tone = '', goal = null, note = '' } = {}) {
  const width = `${Math.max(0, Math.min(1, Number(ratio) || 0)) * 100}%`;
  return h('div', { class: 'meter' },
    label != null || value != null ? h('div', { class: 'meter__top' }, h('span', {}, label), h('span', {}, value)) : null,
    h('div', { class: 'meter__bar' }, h('div', { class: `meter__fill${tone ? ` meter__fill--${tone}` : ''}`, style: { width } }),
      goal != null ? h('div', { class: 'meter__goal', style: { left: `calc(${Math.min(1, goal) * 100}% - 3px)` } }) : null),
    note ? h('span', { class: 'caption muted' }, note) : null);
}

// A segmented control. options: [[value, label], ...]; onPick(value) runs on a tap.
export function seg(options, value, onPick, { label = '' } = {}) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': label || null },
    options.map(([key, text]) => h('button', { type: 'button', class: 'seg__btn', 'aria-pressed': String(key === value), onclick: () => onPick(key) }, text)));
}

export function chips(options, value, onPick, { label = '' } = {}) {
  return h('div', { class: 'chips', role: 'group', 'aria-label': label || null },
    options.map(([key, text]) => h('button', { type: 'button', class: 'seg__btn', 'aria-pressed': String(key === value), onclick: () => onPick(key) }, text)));
}

// Two-column choice buttons that keep one value; returns { el, value() }.
export function choiceGroup(options, initial = '', onChange = () => {}) {
  let current = initial;
  const buttons = options.map(([key, text, small]) => h('button', {
    type: 'button', class: 'choice__btn', 'aria-pressed': String(key === initial), 'data-value': key,
    onclick: () => { current = key; buttons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.value === key))); onChange(key); },
  }, text, small ? h('small', {}, small) : null));
  return { el: h('div', { class: 'choice' }, buttons), value: () => current };
}

export function emptyState(iconName, title, text, action = null) {
  return h('div', { class: 'state state--box' }, icon(iconName), h('h3', {}, title), text ? h('p', {}, text) : null, action);
}

export function loadingState(rows = 4) {
  return h('div', { class: 'stack', role: 'status', 'aria-label': 'Loading' },
    h('div', { class: 'skel', style: { height: '22px', width: '45%' } }),
    Array.from({ length: rows }, (_, i) => h('div', { class: 'skel', style: { height: i === 0 ? '72px' : '56px' } })));
}

export function errorState(error, retry = null) {
  const offline = error?.status === 0;
  return offline
    ? banner('warn', 'wifiOff', 'No signal', 'You\'re seeing what\'s saved on this phone. Doors you log are kept here and sync later.')
    : banner('error', 'alert', 'Couldn\'t load this', `${error?.message || 'The server didn\'t answer.'} Your doors are safe on this phone.`,
      retry ? h('button', { type: 'button', class: 'btn btn--sm btn--retry', onclick: retry }, 'Retry') : null);
}

/* ---------- toast ---------- */

let toastTimer = 0;
export function toast(message, { action = null, tone = '', sub = '', iconName = '' } = {}) {
  const box = document.getElementById('knock-toast');
  if (!box) return;
  const glyph = iconName || (tone === 'bad' ? 'alert' : 'check');
  mount(box, icon(glyph),
    h('div', { class: 'toast__text' }, message, sub ? h('div', { class: 'toast__sub' }, sub) : null),
    action ? h('button', { type: 'button', class: 'toast__undo', onclick: () => { box.hidden = true; action.run(); } }, action.label) : null);
  box.className = `toast${tone === 'bad' ? ' toast--bad' : ''}`;
  box.setAttribute('role', tone === 'bad' ? 'alert' : 'status');
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, action ? 6000 : tone === 'bad' ? 5000 : 3500);
}

/* ---------- sheets ---------- */

// A bottom sheet; resolves with the value passed to close(), or null when dismissed.
// options: { dot: outcome kind for the title dot, subtitle }.
export function sheet(title, build, { dot: dotKind = '', subtitle = '' } = {}) {
  return new Promise(resolve => {
    const dialog = h('dialog', { class: 'sheet', 'aria-label': title });
    const close = value => { if (dialog.open) dialog.close(); dialog.remove(); resolve(value ?? null); };
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(null); });
    dialog.addEventListener('click', event => { if (event.target === dialog) close(null); });
    mount(dialog,
      h('div', { class: 'sheet__handle' }),
      h('div', { class: 'sheet__title' },
        h('div', {}, h('div', { class: 'row', style: { gap: '8px' } }, dotKind ? dot(dotKind) : null, h('h2', {}, title)), subtitle ? h('p', { class: 'muted' }, subtitle) : null),
        h('button', { type: 'button', class: 'ico-btn', 'aria-label': 'Close', onclick: () => close(null) }, icon('close'))),
      build(close));
    document.body.append(dialog);
    dialog.showModal();
  });
}

// A full-screen form with its own top bar (back arrow, title and subtitle).
export function fullScreen(title, subtitle, build) {
  return new Promise(resolve => {
    const dialog = h('dialog', { class: 'fullscreen app', 'aria-label': title });
    const close = value => { if (dialog.open) dialog.close(); dialog.remove(); resolve(value ?? null); };
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(null); });
    mount(dialog,
      h('header', { class: 'topbar' },
        h('button', { type: 'button', class: 'ico-btn', 'aria-label': 'Back', onclick: () => close(null) }, icon('arrowLeft')),
        h('div', { class: 'topbar__title grow' }, h('b', {}, title), subtitle ? h('span', {}, subtitle) : null)),
      build(close));
    document.body.append(dialog);
    dialog.showModal();
  });
}

export async function confirmSheet(title, message, confirmLabel = 'Confirm', tone = 'primary') {
  return sheet(title, close => [
    h('p', {}, message),
    h('button', { type: 'button', class: `btn btn--block ${tone === 'danger' ? 'btn--danger' : 'btn--primary'}`, onclick: () => close(true) }, confirmLabel),
    h('button', { type: 'button', class: 'btn btn--quiet btn--block', onclick: () => close(false) }, 'Cancel'),
  ]);
}

export function downloadText(filename, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
