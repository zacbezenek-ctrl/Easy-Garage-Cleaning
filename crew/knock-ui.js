/* Small DOM and formatting helpers for the knock page. No framework: h() builds elements,
   attributes starting with "on" bind events, everything else is set as an attribute. */

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

export function timeLabel(iso, timeZone = 'America/Denver') {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', { timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let toastTimer = 0;
export function toast(message, { action = null, tone = '' } = {}) {
  const box = document.getElementById('knock-toast');
  if (!box) return;
  mount(box, h('span', {}, message), action ? h('button', { type: 'button', class: 'toast-action', onclick: () => { box.hidden = true; action.run(); } }, action.label) : null);
  box.className = `toast ${tone}`;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, action ? 6000 : 3500);
}

// A modal sheet; resolves with the value passed to close(), or null when dismissed.
export function sheet(title, build) {
  return new Promise(resolve => {
    const dialog = h('dialog', { class: 'sheet', 'aria-label': title });
    const close = value => { dialog.close(); dialog.remove(); resolve(value ?? null); };
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(null); });
    mount(dialog, h('div', { class: 'sheet-head' }, h('h2', {}, title), h('button', { type: 'button', class: 'ghost', onclick: () => close(null), 'aria-label': 'Close' }, 'Close')), build(close));
    document.body.append(dialog);
    dialog.showModal();
  });
}

export async function confirmSheet(title, message, confirmLabel = 'Confirm', tone = 'primary') {
  return sheet(title, close => h('div', {},
    h('p', {}, message),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: tone, onclick: () => close(true) }, confirmLabel),
      h('button', { type: 'button', onclick: () => close(false) }, 'Cancel'))));
}

export function downloadText(filename, text, type = 'text/csv') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
