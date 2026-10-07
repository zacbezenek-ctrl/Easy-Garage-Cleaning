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

/* ---------- Territory ---------- */

function titleStreet(street) {
  return String(street || '').split(' ').map(w => /^(N|S|E|W|NE|NW|SE|SW)$/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
}

function territorySection(params) {
  if (params.get('n')) return neighborhoodHousesSection(params.get('n'));
  return later(async () => {
    const data = await load('territory', {}, { force: true });
    const reps = data.reps.filter(r => r.status === 'active');
    const byRep = key => data.reps.find(r => r.repKey === key)?.displayName || key;
    const refresh = () => { invalidate('territory'); invalidate('coverage'); app.render(); };
    const run = async (body, message = 'Saved') => { try { const result = await action(body, { quiet: true }); toast(message); refresh(); return result; } catch (error) { toast(error.message, { tone: 'bad' }); return null; } };
    if (!data.neighborhoods.length) {
      return h('section', { class: 'card accent' }, h('h2', {}, 'No neighborhoods yet'),
        h('p', {}, 'Seed the 24 neighborhoods (tier, status and platted house count), then run the Larimer County import to load every house.'),
        h('button', { type: 'button', class: 'primary', onclick: () => run({ action: 'territory.seed' }, 'Neighborhoods added') }, 'Seed the 24 neighborhoods'));
    }
    const streetList = h('datalist', { id: 'as-streets' });
    const fillStreets = async neighborhoodId => {
      try {
        const houses = await load('neighborhood', { id: neighborhoodId });
        mount(streetList, [...new Set(houses.houses.map(house => house.street))].sort().map(street => h('option', { value: street })));
      } catch { mount(streetList); }
    };
    const assignForm = h('form', { class: 'card', onsubmit: async event => {
      event.preventDefault();
      await run({ action: 'assignment.set', repKey: assignForm.rep.value, neighborhoodId: assignForm.nbhd.value, street: assignForm.street.value.trim(), active: true }, 'Assigned');
    } },
    h('h2', {}, 'Assign territory'),
    h('p', { class: 'muted' }, 'Reps see only what is assigned to them. Leave the street blank for the whole neighborhood.'),
    h('div', { class: 'grid2' },
      h('div', {}, h('label', { for: 'as-rep' }, 'Rep'), h('select', { id: 'as-rep', name: 'rep', required: true }, reps.map(r => h('option', { value: r.repKey }, r.displayName)))),
      h('div', {}, h('label', { for: 'as-nbhd' }, 'Neighborhood'), h('select', { id: 'as-nbhd', name: 'nbhd', required: true, onchange: event => { assignForm.street.value = ''; fillStreets(event.target.value); } }, data.neighborhoods.map(n => h('option', { value: n.id }, n.name))))),
    h('label', { for: 'as-street' }, 'Street (optional)'),
    h('input', { id: 'as-street', name: 'street', list: 'as-streets', placeholder: 'Whole neighborhood', autocapitalize: 'characters', autocomplete: 'off' }), streetList,
    h('p', {}), h('button', { type: 'submit', class: 'primary' }, 'Assign'));
    if (data.neighborhoods[0]) fillStreets(data.neighborhoods[0].id);

    const noKnock = h('textarea', { rows: '6', placeholder: 'Paste the City\'s no-solicitation addresses, one per line', 'aria-label': 'No-solicitation list' });
    const noKnockResult = h('div', {});
    const noKnockCard = h('section', { class: 'card' },
      h('h2', {}, 'No-knock list'),
      h('p', { class: 'muted' }, 'Houses on the City list never show as knockable again. Reps flag no-soliciting signs from the door.'),
      noKnock,
      h('div', { class: 'row', style: { marginTop: '.5rem' } },
        h('button', { type: 'button', onclick: async () => {
          try {
            const preview = await action({ action: 'noknock.import', text: noKnock.value, apply: false }, { quiet: true });
            mount(noKnockResult, h('p', { class: 'notice' }, `${preview.matched} houses match.${preview.unmatched.length ? ` Not found (${preview.unmatched.length}): ${preview.unmatched.slice(0, 12).join('; ')}${preview.unmatched.length > 12 ? '; …' : ''}` : ''}`));
          } catch (error) { toast(error.message, { tone: 'bad' }); }
        } }, 'Preview'),
        h('button', { type: 'button', class: 'primary', onclick: async () => {
          const result = await run({ action: 'noknock.import', text: noKnock.value, apply: true, requestId: uuid() }, 'No-knock list applied');
          if (result) mount(noKnockResult, h('p', { class: 'notice ok' }, `${result.matched} houses blocked. ${result.unmatched.length} lines did not match a house.`));
        } }, 'Apply')),
      noKnockResult);

    const cards = data.neighborhoods.map(n => {
      const assigned = data.assignments.filter(a => a.neighborhoodId === n.id);
      return h('section', { class: `card${n.status === 'hold' ? '' : ' accent'}` },
        h('div', { class: 'row spread' },
          h('div', {}, h('h3', {}, n.name), h('div', { class: 'muted' }, `${n.importedCount || 0} houses imported · ${n.plattedCount} platted lots · ${n.cityKey}`)),
          h('div', { class: 'row' }, h('span', { class: `badge ${n.tier === 'Premium' ? 'premium' : ''}` }, n.tier), h('span', { class: `badge ${n.status === 'hold' ? 'hold' : 'ok'}` }, n.status === 'hold' ? 'Hold' : 'Open'))),
        n.status === 'hold' ? h('p', { class: 'notice' }, `On hold: ${n.holdReason || 'no reason given'}. Locked for everyone.`) : null,
        n.jurisdictionHoldCount ? h('p', { class: 'notice' }, `${n.jurisdictionHoldCount} imported addresses sit outside this town and stay locked.`) : null,
        h('div', { class: 'row' },
          n.status === 'hold'
            ? h('button', { type: 'button', class: 'primary', onclick: () => run({ action: 'neighborhood.update', id: n.id, changes: { status: 'open' } }, 'Hold cleared') }, 'Clear hold')
            : h('button', { type: 'button', onclick: async () => {
              const reason = await holdReason(n.name);
              if (reason != null) await run({ action: 'neighborhood.update', id: n.id, changes: { status: 'hold', holdReason: reason } }, 'On hold');
            } }, 'Put on hold'),
          h('button', { type: 'button', onclick: () => run({ action: 'neighborhood.update', id: n.id, changes: { tier: n.tier === 'Premium' ? 'Volume' : 'Premium' } }) }, `Make ${n.tier === 'Premium' ? 'Volume' : 'Premium'}`),
          n.unitCount ? h('button', { type: 'button', onclick: () => run({ action: 'neighborhood.excludeUnits', neighborhoodId: n.id, excluded: true }, 'Units excluded') }, `Exclude ${n.unitCount} unit addresses`) : null,
          h('button', { type: 'button', class: 'ghost', onclick: () => app.go('admin', { s: 'territory', n: n.id }) }, 'Houses')),
        assigned.length ? h('ul', { class: 'list' }, assigned.map(a => h('li', {},
          h('span', { style: { flex: '1' } }, `${byRep(a.repKey)} · ${a.street ? titleStreet(a.street) : 'whole neighborhood'}`),
          h('button', { type: 'button', class: 'danger', onclick: () => run({ action: 'assignment.set', repKey: a.repKey, neighborhoodId: a.neighborhoodId, street: a.street, active: false }, 'Unassigned') }, 'Remove'))))
          : h('p', { class: 'muted' }, 'Not assigned.'));
    });
    return h('div', {}, assignForm, noKnockCard, cards);
  });
}

function holdReason(name) {
  return import('./knock-ui.js').then(({ sheet }) => sheet(`Hold ${name}`, close => {
    const input = h('input', { placeholder: 'Why? e.g. Windsor rules not checked', 'aria-label': 'Hold reason' });
    return h('div', { class: 'stack' }, input, h('button', { type: 'button', class: 'primary wide', onclick: () => close(input.value.trim() || 'Held by admin') }, 'Put on hold'));
  }));
}

function neighborhoodHousesSection(id) {
  return later(async () => {
    const data = await load('neighborhood', { id }, { force: true });
    const houses = data.houses.sort((a, b) => a.street.localeCompare(b.street) || Number(a.number) - Number(b.number) || String(a.unit).localeCompare(String(b.unit)));
    const units = houses.filter(h => h.hasUnit);
    const toggle = async (house, excluded) => {
      try { await action({ action: 'house.exclude', houseIds: [house.id], excluded }, { quiet: true }); invalidate('neighborhood'); app.render(); } catch (error) { toast(error.message, { tone: 'bad' }); }
    };
    const clearNoKnock = async house => {
      try { await action({ action: 'noknock.clear', houseId: house.id }); invalidate('neighborhood'); app.render(); } catch (error) { toast(error.message, { tone: 'bad' }); }
    };
    const filter = app.S.route.params.get('f') || 'units';
    const shown = filter === 'units' ? units : filter === 'blocked' ? houses.filter(h => h.noKnock) : houses;
    return h('div', {},
      h('button', { type: 'button', class: 'ghost', onclick: () => app.go('admin', { s: 'territory' }) }, '‹ All neighborhoods'),
      h('h2', {}, data.neighborhood.name),
      h('p', { class: 'muted' }, `${houses.length} houses · ${units.length} with unit numbers · ${houses.filter(h => h.excluded).length} excluded · ${houses.filter(h => h.noKnock).length} no-knock`),
      h('div', { class: 'filters' }, [['units', 'Unit addresses'], ['blocked', 'No-knock'], ['all', 'All houses']].map(([key, label]) =>
        h('button', { type: 'button', 'aria-pressed': String(filter === key), onclick: () => app.go('admin', { s: 'territory', n: id, f: key }) }, label))),
      shown.length ? h('ul', { class: 'list' }, shown.slice(0, 600).map(house => h('li', {},
        h('span', { style: { flex: '1' } }, h('b', {}, `${house.number} ${titleStreet(house.street)}${house.unit ? ` #${house.unit}` : ''}`), h('br', {}),
          h('span', { class: 'muted' }, [house.hasUnit ? 'unit address' : '', house.excluded ? 'excluded' : '', house.noKnock ? `no-knock (${house.noKnock.source})` : '', house.jurisdictionHold ? 'other town' : '', house.summary?.lastOutcome ? `last: ${house.summary.lastOutcome.replace('_', ' ')}` : ''].filter(Boolean).join(' · '))),
        house.noKnock?.source === 'city' ? h('button', { type: 'button', onclick: () => clearNoKnock(house) }, 'Clear') : null,
        h('button', { type: 'button', class: house.excluded ? 'primary' : 'danger', onclick: () => toggle(house, !house.excluded) }, house.excluded ? 'Include' : 'Exclude'))))
        : h('p', { class: 'muted' }, 'Nothing here.'),
      shown.length > 600 ? h('p', { class: 'muted' }, `Showing the first 600 of ${shown.length}.`) : null);
  });
}

/* ---------- Coverage ---------- */

function coverageSection() {
  return later(async () => {
    const { coverage } = await load('coverage', {}, { force: true });
    const open = new Set();
    const table = rows => h('div', { class: 'scroll-x' }, h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, ['Where', 'Knocked', '%', 'Looks', 'Sales', 'Last knocked', 'Here now'].map((label, i) => h('th', { class: i && i < 5 ? 'num' : '' }, label)))),
      h('tbody', {}, rows)));
    const rows = coverage.filter(n => n.total).sort((a, b) => b.percent - a.percent || a.name.localeCompare(b.name)).flatMap(n => [
      h('tr', {},
        h('td', {}, h('button', { type: 'button', class: 'ghost', onclick: event => { const body = event.target.closest('tbody'); body.querySelectorAll(`[data-n="${n.id}"]`).forEach(row => { row.hidden = !row.hidden; }); } }, h('b', {}, n.name)), n.status === 'hold' ? h('span', { class: 'badge hold' }, 'Hold') : null),
        h('td', { class: 'num' }, `${n.knocked}/${n.total}`), h('td', { class: 'num' }, `${n.percent}%`), h('td', { class: 'num' }, String(n.looks)), h('td', { class: 'num' }, String(n.sales)),
        h('td', {}, n.lastKnockedAt ? timeLabel(n.lastKnockedAt) : '—'), h('td', {}, n.hereNow.join(', ') || '—')),
      ...n.streets.map(s => h('tr', { 'data-n': n.id, hidden: !open.has(n.id) },
        h('td', { style: { paddingLeft: '1.4rem' } }, titleStreet(s.street)),
        h('td', { class: 'num' }, `${s.knocked}/${s.total}`), h('td', { class: 'num' }, `${s.percent}%`), h('td', { class: 'num' }, String(s.looks)), h('td', { class: 'num' }, String(s.sales)),
        h('td', {}, s.lastKnockedAt ? timeLabel(s.lastKnockedAt) : '—'), h('td', {}, s.hereNow.join(', ') || '—'))),
    ]);
    return h('div', {}, h('p', { class: 'muted' }, 'Tap a neighborhood to see its streets. Excluded houses and City no-knock houses are left out of the totals.'), table(rows));
  });
}

/* ---------- Sales ---------- */

const SALE_TONE = { booked: 'warn', completed: 'ok', paid: 'ok', cancelled: 'locked' };

function salesSection(params) {
  return later(async () => {
    const data = await load('sales', {}, { force: true });
    const filter = params.get('f') || 'open';
    const repName = key => data.reps.find(r => r.repKey === key)?.displayName || key;
    const shown = data.sales.filter(s => filter === 'all' ? true : filter === 'open' ? ['booked', 'completed'].includes(s.status) : s.status === filter);
    const refresh = () => { invalidate('sales'); app.render(); };
    const act = async (body, message) => {
      try { await action(body, { quiet: true }); toast(message); refresh(); }
      catch (error) { toast(error.message, { tone: 'bad' }); if (error.details?.sale) refresh(); }
    };
    const stripe = data.integrations.deposit.available.includes('stripe');
    const quo = data.integrations.text.available.includes('quo');
    const card = sale => {
      const d = sale.handoff?.deposit || {}, t = sale.handoff?.text || {}, j = sale.handoff?.job || {};
      const ref = h('input', { placeholder: 'Hub job ID or Jobber link (optional)', value: j.ref || '', 'aria-label': 'Job reference' });
      const paidAmount = h('input', { type: 'number', step: '0.01', min: '0', value: String(sale.collectedAmount ?? sale.ticket), 'aria-label': 'Amount collected', style: { maxWidth: '9rem' } });
      const jobDate = h('input', { type: 'date', value: sale.jobDate, min: sale.earliestJobDate, 'aria-label': 'Job date', style: { maxWidth: '11rem' } });
      return h('section', { class: 'card' },
        h('div', { class: 'row spread' },
          h('div', {}, h('h3', {}, `${sale.address.number} ${titleStreet(sale.address.street)}${sale.address.unit ? ` #${sale.address.unit}` : ''}`),
            h('div', { class: 'muted' }, `${repName(sale.repKey)} · sold ${timeLabel(sale.soldAt)}`)),
          h('span', { class: `badge ${SALE_TONE[sale.status] || ''}` }, sale.status)),
        h('p', {}, h('b', {}, sale.customer.name), ' · ', h('a', { href: `tel:${sale.customer.phone}` }, sale.customer.phone), ' · ', h('a', { href: `mailto:${sale.customer.email}` }, sale.customer.email)),
        h('p', {}, `${sale.package} · ${money(sale.ticket)} · deposit ${money(sale.depositAmount, true)} · job ${dateLabel(sale.jobDate)} ${sale.jobStartTime || ''}`),
        h('p', { class: 'muted' }, `Cancel deadline: midnight ${dateLabel(sale.cancelDeadlineDate)}. ${sale.refund} Checklist confirmed ${timeLabel(sale.checklistConfirmedAt)}.${sale.textConsent ? '' : ' No text consent.'}`),
        h('div', { class: 'handoffs' },
          h('div', { class: 'handoff' }, h('b', {}, 'Job'), h('span', { class: 'badge' }, j.status || 'pending'), ref,
            h('button', { type: 'button', onclick: () => act({ action: 'sale.handoff', saleId: sale.id, kind: 'job', op: 'mark', ref: ref.value }, 'Job marked created') }, j.status === 'created' ? 'Update' : 'Mark created')),
          h('div', { class: 'handoff' }, h('b', {}, 'Deposit'), h('span', { class: `badge ${d.status === 'collected' ? 'ok' : ''}` }, d.status || 'pending'),
            d.url ? h('a', { href: d.url, target: '_blank', rel: 'noopener' }, 'Payment link') : null,
            stripe && d.status !== 'collected' && !d.url ? h('button', { type: 'button', class: 'primary', onclick: () => act({ action: 'sale.handoff', saleId: sale.id, kind: 'deposit', op: 'start' }, 'Stripe link created') }, 'Create Stripe link') : null,
            d.url && d.status !== 'collected' ? h('button', { type: 'button', onclick: () => act({ action: 'sale.handoff', saleId: sale.id, kind: 'deposit', op: 'refresh' }, 'Checked with Stripe') }, 'Check payment') : null,
            d.status !== 'collected' ? h('button', { type: 'button', onclick: () => act({ action: 'sale.handoff', saleId: sale.id, kind: 'deposit', op: 'mark' }, 'Deposit marked collected') }, 'Mark collected') : null),
          h('div', { class: 'handoff' }, h('b', {}, 'Text'), h('span', { class: `badge ${t.status === 'sent' ? 'ok' : ''}` }, t.status || 'pending'),
            quo && sale.textConsent && !['sent', 'uncertain', 'sending'].includes(t.status) ? h('button', { type: 'button', class: 'primary', onclick: async () => {
              if (await confirmSheet('Send one text?', sale.message, 'Send text')) act({ action: 'sale.handoff', saleId: sale.id, kind: 'text', op: 'send' }, 'Text sent');
            } }, 'Send via Quo') : null,
            t.status !== 'sent' ? h('button', { type: 'button', onclick: () => act({ action: 'sale.handoff', saleId: sale.id, kind: 'text', op: 'mark' }, 'Text marked sent') }, 'Mark sent') : null,
            t.error ? h('span', { class: 'notice error' }, t.error) : null)),
        h('details', {}, h('summary', {}, 'Customer text'), h('p', {}, sale.message)),
        h('div', { class: 'row', style: { marginTop: '.6rem' } },
          sale.status === 'booked' ? h('button', { type: 'button', onclick: () => act({ action: 'sale.status', saleId: sale.id, status: 'completed' }, 'Marked completed') }, 'Job completed') : null,
          ['booked', 'completed'].includes(sale.status) ? h('span', { class: 'row' }, paidAmount, h('button', { type: 'button', class: 'primary', onclick: () => act({ action: 'sale.status', saleId: sale.id, status: 'paid', collectedAmount: paidAmount.value }, 'Marked paid') }, 'Mark paid')) : null,
          sale.status !== 'cancelled' ? h('button', { type: 'button', class: 'danger', onclick: async () => {
            if (await confirmSheet('Cancel this sale?', 'A cancelled sale pays no commission. Refund the deposit according to the cancellation rules.', 'Cancel sale', 'danger')) act({ action: 'sale.status', saleId: sale.id, status: 'cancelled' }, 'Sale cancelled');
          } }, 'Cancel sale') : h('button', { type: 'button', onclick: () => act({ action: 'sale.status', saleId: sale.id, status: 'booked' }, 'Sale reinstated') }, 'Reinstate'),
          sale.status !== 'cancelled' ? h('span', { class: 'row' }, jobDate, h('button', { type: 'button', onclick: () => act({ action: 'sale.jobDate', saleId: sale.id, jobDate: jobDate.value }, 'Job date saved') }, 'Move job')) : null));
    };
    return h('div', {},
      h('p', { class: 'muted' }, `Hand-offs: job ${data.integrations.job.mode}; deposit ${stripe ? 'Stripe link or manual' : 'manual (no Stripe key on the server)'}; text ${quo ? 'Quo or manual' : 'manual (no Quo key on the server)'}. One customer, one text: there is no bulk send.`),
      h('div', { class: 'filters' }, [['open', 'Open'], ['booked', 'Booked'], ['completed', 'Completed'], ['paid', 'Paid'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([key, label]) =>
        h('button', { type: 'button', 'aria-pressed': String(filter === key), onclick: () => app.go('admin', { s: 'sales', f: key }) }, label))),
      shown.length ? shown.map(card) : h('p', { class: 'muted' }, 'No sales here.'));
  });
}

/* ---------- Money ---------- */

function moneySection(params) {
  return later(async () => {
    const date = params.get('date') || zonedDate(Date.now());
    const data = await load('money', { date }, { force: true });
    const period = data.period;
    const go = target => app.go('admin', { s: 'money', date: target });
    const exportCsv = async kind => {
      try {
        const file = await app.api(`/api/knock-admin?view=export&kind=${kind}&date=${encodeURIComponent(period.start)}`);
        downloadText(file.filename, file.csv);
      } catch (error) { toast(error.message, { tone: 'bad' }); }
    };
    const payoutForm = row => {
      const amount = h('input', { type: 'number', step: '0.01', min: '0', value: row.balance > 0 ? String(row.balance) : '', placeholder: 'Amount', 'aria-label': `Payout for ${row.name}`, style: { maxWidth: '8rem' } });
      const note = h('input', { placeholder: 'Note (check #)', 'aria-label': 'Payout note', style: { maxWidth: '10rem' } });
      return h('span', { class: 'row' }, amount, note, h('button', { type: 'button', onclick: async () => {
        try { await action({ action: 'payout.add', requestId: uuid(), repKey: row.repKey, periodKey: period.key, amount: Number(amount.value), note: note.value }); invalidate('money'); app.render(); }
        catch (error) { toast(error.message, { tone: 'bad' }); }
      } }, 'Record paid'));
    };
    const total = key => data.statement.reduce((sum, r) => sum + Number(r[key] || 0), 0);
    return h('div', {},
      h('div', { class: 'row spread' },
        h('button', { type: 'button', onclick: () => go(data.previous.start) }, '‹ Previous'),
        h('b', {}, `${dateLabel(period.start)} to ${dateLabel(period.end)}`),
        h('button', { type: 'button', onclick: () => go(data.next.start) }, 'Next ›')),
      h('p', { class: 'muted' }, `Commission ${percent(data.rates.rate)} of collected revenue once a job is completed, paid and past its cancellation deadline${data.rates.acceleratorEnabled ? `; ${percent(data.rates.acceleratorRate)} above ${money(data.rates.acceleratorThreshold)} collected in a month` : ''}${data.rates.leadOverrideEnabled ? `; lead override ${percent(data.rates.leadOverrideRate)} of team collected revenue` : ''}. Training is paid at ${money(data.trainingHourlyRate, true)}/h. Pay periods: ${data.payroll.period}.`),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'primary', onclick: () => exportCsv('commission') }, 'Commission CSV'),
        h('button', { type: 'button', onclick: () => exportCsv('training') }, 'Training CSV'),
        h('button', { type: 'button', onclick: () => exportCsv('sales') }, 'Sales CSV')),
      h('div', { class: 'scroll-x', style: { marginTop: '.6rem' } }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, ['Rep', 'Sales', 'Booked', 'Pending', 'Earned', 'Override', 'Paid', 'Balance', 'Training'].map((label, i) => h('th', { class: i ? 'num' : '' }, label)))),
        h('tbody', {},
          data.statement.map(row => h('tr', {},
            h('td', {}, row.name), h('td', { class: 'num' }, String(row.salesBooked)), h('td', { class: 'num' }, money(row.booked)), h('td', { class: 'num' }, money(row.pending, true)),
            h('td', { class: 'num' }, money(row.earned, true)), h('td', { class: 'num' }, money(row.override, true)), h('td', { class: 'num' }, money(row.paid, true)),
            h('td', { class: 'num' }, h('b', {}, money(row.balance, true))), h('td', { class: 'num' }, row.trainingMinutes ? `${hoursLabel(row.trainingMinutes * 60000)} · ${money(row.trainingPay, true)}` : '—'))),
          h('tr', {}, h('td', {}, h('b', {}, 'Total')), h('td', { class: 'num' }, String(total('salesBooked'))), h('td', { class: 'num' }, money(total('booked'))), h('td', { class: 'num' }, money(total('pending'), true)),
            h('td', { class: 'num' }, money(total('earned'), true)), h('td', { class: 'num' }, money(total('override'), true)), h('td', { class: 'num' }, money(total('paid'), true)), h('td', { class: 'num' }, h('b', {}, money(total('balance'), true))), h('td', { class: 'num' }, money(total('trainingPay'), true)))))),
      h('section', { class: 'card', style: { marginTop: '.8rem' } }, h('h3', {}, 'Record a payout'),
        data.statement.filter(r => r.earned || r.override || r.balance).length
          ? h('ul', { class: 'list' }, data.statement.filter(r => r.earned || r.override || r.balance).map(row => h('li', {}, h('span', { style: { flex: '1' } }, `${row.name} · balance ${money(row.balance, true)}`), payoutForm(row))))
          : h('p', { class: 'muted' }, 'Nothing earned in this period yet.'),
        data.payouts.length ? h('p', { class: 'muted' }, `Recorded: ${data.payouts.map(p => `${p.repKey} ${money(p.amount, true)}${p.note ? ` (${p.note})` : ''}`).join('; ')}`) : null));
  });
}

/* ---------- Flags ---------- */

function flagsSection() {
  return later(async () => {
    const data = await load('flags', {}, { force: true });
    if (!data.flags.length) return h('p', { class: 'muted' }, 'Nothing to review. Doors logged after sunset, outside the hours, on a City no-knock house or on an excluded house show here.');
    return h('div', {},
      h('p', { class: 'muted' }, 'Doors to review with the rep. After sunset a rep may finish the door they were at for 15 minutes; it is recorded and flagged here.'),
      h('ul', { class: 'list' }, data.flags.map(flag => h('li', {},
        h('span', { style: { flex: '1' } }, h('b', {}, flag.address || flag.type), ' · ', flag.rep, h('br', {}),
          h('span', { class: 'muted' }, `${timeLabel(flag.at)}${flag.outcome ? ` · ${flag.outcome.replace('_', ' ')}` : ''}`)),
        h('span', { class: 'row' }, flag.flags.map(f => h('span', { class: `badge ${f === 'after_sunset' ? 'warn' : 'locked'}` }, data.labels[f] || f)))))));
  });
}

/* ---------- Scoreboard ---------- */

function scoreboardSection(params) {
  return later(async () => {
    const { scoreboardBody } = await import('./knock-stats-ui.js');
    const rangeKey = params.get('range') || 'week', groupBy = params.get('groupBy') || 'rep';
    const data = await app.api(`/api/knock-reports?view=scoreboard&range=${encodeURIComponent(rangeKey)}&groupBy=${encodeURIComponent(groupBy)}`);
    return scoreboardBody(data, {
      onRange: key => app.go('admin', { s: 'scoreboard', range: key, groupBy }),
      onGroup: key => app.go('admin', { s: 'scoreboard', range: rangeKey, groupBy: key }),
    });
  });
}

const extraSections = [];
export function addSection(key, label, render) { extraSections.push([key, label, render]); }

export function install(appApi) {
  app = appApi;
  registerAdminSection('reps', 'Reps', repsSection);
  registerAdminSection('territory', 'Territory', territorySection);
  registerAdminSection('coverage', 'Coverage', coverageSection);
  registerAdminSection('sales', 'Sales', salesSection);
  registerAdminSection('money', 'Money', moneySection);
  registerAdminSection('scoreboard', 'Scoreboard', scoreboardSection);
  registerAdminSection('flags', 'Flags', flagsSection);
  for (const extra of extraSections) registerAdminSection(...extra);
  registerAdminSection('settings', 'Settings', settingsSection);
  app.registerScreen('admin', adminScreen, { admin: true, tab: { label: 'Admin', glyph: '⚙', order: 90 } });
}

export { app as adminApp, load, money, percent, number, hoursLabel, dateLabel, timeLabel, downloadText, confirmSheet };
