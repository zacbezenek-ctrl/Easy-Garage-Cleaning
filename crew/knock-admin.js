/* Admin screens for canvassing: reps, territory, sales, money, scoreboard, flags and settings.
   Loaded only for Hub business users; the server re-checks every request. */
import { h, mount, money, toast, uuid, confirmSheet, downloadText, dateLabel, timeLabel, percent, number, hoursLabel } from './knock-ui.js';
import { zonedDate } from './knock-time.js';

let app;
const sections = [];

export function registerAdminSection(key, label, render) {
  sections.push({ key, label, render });
}

function adminNav(active) {
  return h('div', { class: 'filters', role: 'tablist' }, sections.map(section =>
    h('button', { type: 'button', 'aria-pressed': String(section.key === active), onclick: () => app.go('admin', { s: section.key }) }, section.label)));
}

const cache = {};
async function load(view, params = {}, { force = false } = {}) {
  const key = view + JSON.stringify(params);
  if (!force && cache[key]) return cache[key];
  cache[key] = app.api(`/api/knock-admin?${new URLSearchParams({ view, ...params })}`);
  try { return await cache[key]; } catch (error) { delete cache[key]; throw error; }
}
export function invalidate(prefix = '') {
  for (const key of Object.keys(cache)) if (key.startsWith(prefix)) delete cache[key];
}
export async function action(body, { quiet = false } = {}) {
  const result = await app.api('/api/knock-admin', { method: 'POST', body });
  if (!quiet) toast('Saved');
  return result;
}

// Render an async section: a placeholder first, then the content (or the error).
export function later(promiseFactory) {
  const box = h('div', {}, h('p', { class: 'loading' }, 'Loading…'));
  Promise.resolve().then(promiseFactory).then(node => mount(box, node), error => mount(box, h('p', { class: 'notice error' }, error.message)));
  return box;
}

function adminScreen(_app, params) {
  const key = params.get('s') || sections[0].key;
  const section = sections.find(s => s.key === key) || sections[0];
  return h('div', {}, h('h1', {}, 'Admin'), adminNav(section.key), section.render(params));
}

/* ---------- Reps ---------- */

function repsSection() {
  return later(async () => {
    const data = await load('reps');
    const reps = data.reps;
    const leads = reps.filter(r => r.status === 'active' && ['lead', 'admin'].includes(r.role));
    const rerender = () => { invalidate('reps'); app.render(); };
    const set = async (rep, changes) => { try { await action({ action: 'rep.update', repKey: rep.repKey, changes }); rerender(); } catch (error) { toast(error.message, { tone: 'bad' }); } };
    const trainingTotals = new Map();
    for (const t of data.training) trainingTotals.set(t.repKey, (trainingTotals.get(t.repKey) || 0) + t.minutes);
    return h('div', {},
      h('p', { class: 'muted' }, 'New reps sign in with their Hub account and wait here. A rep needs Active and the City permit list to start a shift.'),
      reps.map(rep => h('section', { class: `card${rep.status === 'pending' ? ' accent' : ''}` },
        h('div', { class: 'row spread' },
          h('div', {}, h('h3', {}, rep.displayName), h('div', { class: 'muted' }, `${rep.username} · ${rep.role}`)),
          h('span', { class: `badge ${rep.status === 'active' ? 'ok' : rep.status === 'pending' ? 'warn' : 'locked'}` }, rep.status)),
        h('div', { class: 'row' },
          rep.status !== 'active' ? h('button', { type: 'button', class: 'primary', onclick: () => set(rep, { status: 'active' }) }, rep.status === 'pending' ? 'Approve' : 'Reactivate') : null,
          rep.status === 'active' && rep.role !== 'admin' ? h('button', { type: 'button', class: 'danger', onclick: () => set(rep, { status: 'inactive' }) }, 'Deactivate') : null),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: rep.permitListed, onchange: e => set(rep, { permitListed: e.target.checked }) }), 'On the City permit list'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: rep.premiumCleared, onchange: e => set(rep, { premiumCleared: e.target.checked }) }), 'Cleared for Premium streets'),
        rep.role === 'admin' ? null : h('div', { class: 'grid2' },
          h('div', {}, h('label', {}, 'Role'), h('select', { onchange: e => set(rep, { role: e.target.value }) },
            ['knocker', 'lead'].map(role => h('option', { value: role, selected: rep.role === role }, role)))),
          h('div', {}, h('label', {}, 'Lead'), h('select', { onchange: e => set(rep, { leadKey: e.target.value }) },
            h('option', { value: '' }, 'No lead'),
            leads.filter(l => l.repKey !== rep.repKey).map(l => h('option', { value: l.repKey, selected: rep.leadKey === l.repKey }, l.displayName))))),
        trainingForm(rep, trainingTotals.get(rep.repKey) || 0, rerender))));
  });
}

function trainingForm(rep, minutes, rerender) {
  const today = zonedDate(Date.now());
  const form = h('form', { class: 'row', onsubmit: async event => {
    event.preventDefault();
    try {
      await action({ action: 'training.add', requestId: uuid(), repKey: rep.repKey, date: form.date.value, minutes: Number(form.minutes.value), note: form.note.value });
      rerender();
    } catch (error) { toast(error.message, { tone: 'bad' }); }
  } },
  h('span', { class: 'muted', style: { flexBasis: '100%' } }, `Training logged: ${hoursLabel(minutes * 60000)} h (paid hourly, separate from knocking)`),
  h('input', { name: 'date', type: 'date', value: today, style: { flex: '1 1 150px' }, 'aria-label': 'Training date' }),
  h('input', { name: 'minutes', type: 'number', min: '1', max: '720', placeholder: 'Minutes', style: { flex: '1 1 100px' }, 'aria-label': 'Training minutes', required: true }),
  h('input', { name: 'note', placeholder: 'Note', style: { flex: '2 1 160px' }, 'aria-label': 'Training note' }),
  h('button', { type: 'submit' }, 'Log training'));
  return form;
}

/* ---------- Settings ---------- */

function settingsSection() {
  return later(async () => {
    const data = await load('settings', {}, { force: true });
    const draft = structuredClone(data.settings);
    const fields = [];
    const scalar = (group, key, value) => {
      const id = `s-${group}-${key}`;
      const input = typeof value === 'boolean'
        ? h('input', { id, type: 'checkbox', checked: value, onchange: e => { draft[group][key] = e.target.checked; } })
        : h('input', { id, type: typeof value === 'number' ? 'number' : 'text', step: 'any', value: String(value), onchange: e => { draft[group][key] = typeof value === 'number' ? Number(e.target.value) : e.target.value; } });
      return typeof value === 'boolean' ? h('label', { class: 'check' }, input, `${group}.${key}`) : h('div', {}, h('label', { for: id }, `${group}.${key}`), input);
    };
    for (const [group, values] of Object.entries(draft)) {
      if (typeof values !== 'object' || values === null) continue;
      const items = [];
      for (const [key, value] of Object.entries(values)) {
        if (value !== null && typeof value === 'object') {
          const id = `s-${group}-${key}`;
          items.push(h('div', {}, h('label', { for: id }, `${group}.${key} (JSON)`),
            h('textarea', { id, rows: String(Math.min(14, JSON.stringify(value, null, 2).split('\n').length + 1)), onchange: e => {
              try { draft[group][key] = JSON.parse(e.target.value); e.target.setCustomValidity(''); } catch { e.target.setCustomValidity('Not valid JSON'); e.target.reportValidity(); }
            } }, JSON.stringify(value, null, 2))));
        } else items.push(scalar(group, key, value));
      }
      fields.push(h('section', { class: 'card' }, h('h3', {}, group), items));
    }
    const problems = h('div', {});
    return h('div', {},
      h('p', { class: 'muted' }, `Every legal and pay number lives here so it can change after legal review. ${data.updatedAt ? `Last saved ${timeLabel(data.updatedAt)} by ${data.updatedBy}.` : 'Using the defaults.'}`),
      fields, problems,
      h('button', { type: 'button', class: 'primary wide', onclick: async () => {
        try {
          await action({ action: 'settings.update', settings: draft });
          invalidate('settings');
          await app.sync({ full: true });
        } catch (error) {
          mount(problems, h('div', { class: 'notice error' }, error.message, h('ul', {}, (error.details?.problems || []).map(p => h('li', {}, p)))));
        }
      } }, 'Save settings'));
  });
}

export function install(appApi) {
  app = appApi;
  registerAdminSection('reps', 'Reps', repsSection);
  for (const extra of extraSections) registerAdminSection(...extra);
  registerAdminSection('settings', 'Settings', settingsSection);
  app.registerScreen('admin', adminScreen, { admin: true, tab: { label: 'Admin', glyph: '⚙', order: 90 } });
}

// Sections added by later modules (territory, sales, money, scoreboard, flags) register here.
const extraSections = [];
export function addSection(key, label, render) { extraSections.push([key, label, render]); }
export { app as adminApp, load, money, percent, number, hoursLabel, dateLabel, timeLabel, downloadText, confirmSheet };
