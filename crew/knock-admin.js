/* Admin screens for canvassing: reps, territory, coverage, sales, money, scoreboard, flags and
   settings. A navy sidebar on a laptop; the top bar, section chips and the Admin tab on a phone.
   Loaded only for Hub business users; the server re-checks every request. */
import {
  h, mount, money, toast, uuid, confirmSheet, sheet, downloadText, dateLabel, timeLabel, percent, number, hoursLabel, longDateLabel, wallTime, phoneLabel,
  icon, dot, badge, banner, kv, stat, meter, seg, chips, emptyState, loadingState, errorState,
} from './knock-ui.js';
import { zonedDate } from './knock-time.js';
import { cancellationWindow } from './knock-sale-rules.js';
import { periodLabel } from './knock-stats-ui.js';

let app;
const sections = [];

export function registerAdminSection(key, label, iconName, load) {
  sections.push({ key, label, icon: iconName, load });
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
const go = (section, params = {}) => app.go('admin', { s: section, ...params });
const titleStreet = street => String(street || '').split(' ').map(w => /^(N|S|E|W|NE|NW|SE|SW)$/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()).join(' ');
const field = (label, input, hint = null, id = '') => h('div', { class: 'field' }, h('label', { class: 'label', ...(id ? { for: id } : {}) }, label), input, hint ? h('span', { class: 'hint' }, hint) : null);

/* ---------- shell ---------- */

function sidebar(active) {
  const { state, label } = app.syncSummary();
  return h('nav', { class: 'admin__nav', 'aria-label': 'Admin' },
    h('a', { class: 'wordmark', href: '#home' }, 'EGC ', h('em', {}, 'Knock')),
    sections.map(section => h('a', { class: `nav-item${section.key === active ? ' nav-item--active' : ''}`, href: `#admin?s=${section.key}`, 'aria-current': section.key === active ? 'page' : false },
      icon(section.icon), section.label)),
    h('div', { class: 'spacer' }),
    h('span', { class: 'caption', style: { opacity: '.7', padding: '0 12px 4px' } }, 'Rep app'),
    h('a', { class: 'nav-item', href: '#knock' }, icon('door'), 'Knock'),
    h('a', { class: 'nav-item', href: '#map' }, icon('map'), 'Map'),
    h('a', { class: 'nav-item', href: '#more' }, icon('more'), 'More'),
    h('button', { type: 'button', class: `sync sync--${state}`, 'data-sync-pill': '', onclick: () => app.go('more') }, h('span', { class: 'sync__dot' }), label));
}

function adminScreen(_app, params) {
  const section = sections.find(s => s.key === params.get('s')) || sections[0];
  const subtitle = h('p', { class: 'muted' });
  const actions = h('div', { class: 'row wrap', style: { gap: '10px' } });
  const body = h('div', { class: 'admin__body' }, loadingState(4));
  const titleBox = h('div', {}, h('h1', {}, section.label), subtitle);
  const show = () => Promise.resolve().then(() => section.load(params)).then(result => {
    if (result.title) mount(titleBox, result.title, subtitle);
    mount(subtitle, result.subtitle || '');
    mount(actions, result.actions || null);
    mount(body, result.body);
  }, error => mount(body, errorState(error, () => { invalidate(); app.render(); })));
  show();
  return h('div', { class: 'admin' },
    sidebar(section.key),
    h('div', { class: 'admin__main' },
      h('div', { class: 'admin__sections' }, chips(sections.map(s => [s.key, s.label]), section.key, key => go(key), { label: 'Admin section' })),
      h('div', { class: 'admin__head' }, titleBox, actions),
      body));
}

/* ---------- Reps ---------- */

async function repsSection(params) {
  const [data, coverage] = await Promise.all([load('reps'), load('coverage').catch(() => null)]);
  const reps = data.reps;
  const pending = reps.filter(r => r.status === 'pending');
  const active = reps.filter(r => r.status === 'active');
  const inactive = reps.filter(r => r.status === 'inactive');
  const filter = params.get('f') || 'all';
  const leads = active.filter(r => ['lead', 'admin'].includes(r.role));
  const rerender = () => { invalidate('reps'); app.render(); };
  const set = async (rep, changes, message = 'Saved') => {
    try { await action({ action: 'rep.update', repKey: rep.repKey, changes }, { quiet: true }); toast(message, { sub: rep.displayName }); rerender(); }
    catch (error) { toast(error.message, { tone: 'bad' }); }
  };
  // Where each rep is knocking right now, from the coverage view's "here now" names.
  const hereNow = new Map();
  for (const n of coverage?.coverage || []) {
    for (const s of n.streets) for (const name of s.hereNow) if (!hereNow.has(name)) hereNow.set(name, `${n.name} · ${titleStreet(s.street)}`);
    for (const name of n.hereNow) if (!hereNow.has(name)) hereNow.set(name, n.name);
  }
  const search = h('input', { class: 'input input--sm', type: 'search', placeholder: 'Find a rep', 'aria-label': 'Find a rep', style: { width: '220px' },
    oninput: () => {
      const q = search.value.trim().toLowerCase();
      document.querySelectorAll('[data-rep-row]').forEach(row => { row.hidden = Boolean(q) && !row.dataset.repRow.includes(q); });
    } });
  const shown = active.filter(r => filter === 'all' || (filter === 'leads' ? r.role === 'lead' : r.role === 'knocker'));
  const roleSeg = rep => rep.role === 'admin' ? badge('Admin', 'navy')
    : seg([['knocker', 'Knocker'], ['lead', 'Lead']], rep.role, role => { if (role !== rep.role) set(rep, { role }, `Now a ${role}`); }, { label: `Role for ${rep.displayName}` });
  const check = (rep, key, labelOn, labelOff, warn = false) => h('label', { class: `check check--sm${!rep[key] && warn ? ' check--warn' : ''}` },
    h('input', { type: 'checkbox', checked: rep[key], onchange: e => set(rep, { [key]: e.target.checked }) }), rep[key] ? labelOn : labelOff);
  const knocking = rep => {
    if (!rep.permitListed) return badge('Can\'t knock · no permit', 'warning');
    const where = hereNow.get(rep.displayName);
    return where ? h('span', { class: 'badge badge--success' }, h('span', { class: 'sync__dot', style: { background: 'var(--success)' } }), `Now · ${where}`) : badge('Off right now');
  };
  return {
    subtitle: `${active.length} active · ${pending.length} waiting for approval`,
    actions: search,
    body: [
      pending.length ? h('section', { class: 'card card--accent', style: { gap: '12px' } },
        h('div', { class: 'row row--between' }, h('h2', { style: { fontSize: '20px' } }, 'Waiting for approval'), badge(String(pending.length), 'orange')),
        h('div', { class: 'cols' }, pending.map(rep => h('div', { class: 'card card--line', style: { gap: '10px' } },
          h('div', { class: 'row row--between wrap' }, h('span', { class: 'serif', style: { fontSize: '20px' } }, rep.displayName),
            h('span', { class: 'caption muted' }, rep.createdAt ? `Signed up ${timeLabel(rep.createdAt)}` : 'New')),
          h('div', { class: 'caption muted' }, rep.username),
          h('div', { class: 'row', style: { gap: '10px' } },
            h('button', { type: 'button', class: 'btn btn--success grow', onclick: () => set(rep, { status: 'active' }, 'Approved') }, icon('check'), 'Approve'),
            h('button', { type: 'button', class: 'btn btn--danger grow', onclick: () => set(rep, { status: 'inactive' }, 'Deactivated') }, 'Deactivate')))))) : null,
      h('section', { class: 'stack' },
        h('div', { class: 'row row--between wrap' }, h('h2', { style: { fontSize: '20px' } }, 'Active reps'),
          h('div', { style: { width: '300px', maxWidth: '100%' } }, seg([['all', 'All'], ['leads', 'Leads'], ['knockers', 'Knockers']], filter, key => go('reps', { f: key }), { label: 'Filter reps' }))),
        shown.length ? h('div', { class: 'card card--line table-wrap' }, h('table', { class: 'table' },
          h('thead', {}, h('tr', {}, ['Rep', 'Role', 'City permit', 'Premium', 'Training', 'Knocking', ''].map(label => h('th', {}, label)))),
          h('tbody', {}, shown.map(rep => h('tr', { 'data-rep-row': `${rep.displayName} ${rep.username}`.toLowerCase() },
            h('td', {}, h('b', {}, rep.displayName), h('div', { class: 'caption muted' }, rep.username)),
            h('td', { style: { minWidth: '190px' } }, roleSeg(rep)),
            h('td', {}, check(rep, 'permitListed', 'On list', 'Not yet', true)),
            h('td', {}, check(rep, 'premiumCleared', 'Cleared', 'Cleared')),
            h('td', {}, rep.trainingMinutes ? [h('b', {}, `${rep.trainingMinutes} min`), h('div', { class: 'caption muted' }, `${Math.round(rep.trainingMinutes / 6) / 10} h`)] : h('b', {}, '–')),
            h('td', {}, knocking(rep)),
            h('td', {}, h('button', { type: 'button', class: 'btn btn--quiet btn--sm', onclick: () => editRep(rep, leads, set, rerender) }, 'Edit'))))))) : emptyState('user', 'Nobody here', 'Try another filter.'),
        h('p', { class: 'caption muted' }, `Showing ${shown.length} of ${active.length}. New reps sign in with their Hub account and wait for approval. Deactivated reps are kept for pay history and never deleted.`)),
      inactive.length ? h('section', { class: 'stack' },
        h('h2', { style: { fontSize: '20px' } }, 'Deactivated'),
        h('div', { class: 'list list--boxed' }, inactive.map(rep => h('div', { class: 'list-row list-row--static' },
          h('span', { class: 'list-row__main' }, h('span', { class: 'list-row__title' }, rep.displayName), h('span', { class: 'list-row__sub' }, `${rep.username}${rep.deactivatedAt ? ` · since ${timeLabel(rep.deactivatedAt)}` : ''}`)),
          h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => set(rep, { status: 'active' }, 'Reactivated') }, 'Reactivate'))))) : null,
    ],
  };
}

function editRep(rep, leads, set, rerender) {
  const today = zonedDate(Date.now());
  return sheet(rep.displayName, close => {
    const lead = h('select', { class: 'input', id: 'rep-lead' }, h('option', { value: '' }, 'No lead'),
      leads.filter(l => l.repKey !== rep.repKey).map(l => h('option', { value: l.repKey, selected: rep.leadKey === l.repKey }, l.displayName)));
    const date = h('input', { class: 'input', id: 'tr-date', type: 'date', value: today });
    const minutes = h('input', { class: 'input', id: 'tr-min', type: 'number', min: '1', max: '720', inputmode: 'numeric', placeholder: '90' });
    const note = h('input', { class: 'input', id: 'tr-note', placeholder: 'Door script and safety' });
    return [
      field('Lead', lead, 'A lead earns a bonus on their team\'s sales.', 'rep-lead'),
      h('button', { type: 'button', class: 'btn btn--secondary btn--block', onclick: async () => { await set(rep, { leadKey: lead.value }, 'Lead saved'); close(true); } }, 'Save lead'),
      h('h3', {}, 'Log training'),
      h('p', { class: 'caption muted' }, `${hoursLabel(rep.trainingMinutes * 60000)} h logged so far. Training is paid by the hour, separate from knocking.`),
      h('div', { class: 'fields-2' }, field('Date', date, null, 'tr-date'), field('Minutes', minutes, null, 'tr-min')),
      field('Note', note, null, 'tr-note'),
      h('button', { type: 'button', class: 'btn btn--primary btn--block', onclick: async () => {
        try {
          await action({ action: 'training.add', requestId: uuid(), repKey: rep.repKey, date: date.value, minutes: Number(minutes.value), note: note.value }, { quiet: true });
          toast('Training logged', { sub: `${minutes.value} min · ${rep.displayName}` });
          close(true); rerender();
        } catch (error) { toast(error.message, { tone: 'bad' }); }
      } }, 'Log training'),
      rep.role === 'admin' ? null : h('button', { type: 'button', class: 'btn btn--danger btn--block', onclick: async () => {
        if (await confirmSheet(`Deactivate ${rep.displayName}?`, 'They can\'t sign in to knock until you reactivate them. Their pay history stays.', 'Deactivate', 'danger')) { await set(rep, { status: 'inactive' }, 'Deactivated'); close(true); }
      } }, 'Deactivate'),
    ];
  }, { subtitle: `${rep.username} · ${rep.role}` });
}

/* ---------- Territory ---------- */

async function territorySection(params) {
  if (params.get('n')) return neighborhoodHousesSection(params.get('n'), params);
  const [data, coverage] = await Promise.all([load('territory', {}, { force: true }), load('coverage').catch(() => null)]);
  const refresh = () => { invalidate('territory'); invalidate('coverage'); app.render(); };
  const run = async (body, message = 'Saved') => {
    try { const result = await action(body, { quiet: true }); toast(message); refresh(); return result; }
    catch (error) { toast(error.message, { tone: 'bad' }); return null; }
  };
  if (!data.neighborhoods.length) {
    return { subtitle: 'No neighborhoods yet', body: emptyState('map', 'Seed the neighborhoods', 'Add the 24 neighborhoods (tier, status and platted house count), then run the Larimer County import to load every house.',
      h('button', { type: 'button', class: 'btn btn--primary', onclick: () => run({ action: 'territory.seed' }, 'Neighborhoods added') }, 'Seed the 24 neighborhoods')) };
  }
  const repName = key => data.reps.find(r => r.repKey === key)?.displayName || key;
  const knockedBy = new Map((coverage?.coverage || []).map(n => [n.id, n.knocked]));
  const selected = data.neighborhoods.find(n => n.id === params.get('sel')) || data.neighborhoods[0];
  const totalHouses = data.neighborhoods.reduce((sum, n) => sum + (n.importedCount || 0), 0);
  const find = h('input', { class: 'input input--sm', type: 'search', placeholder: 'Find', 'aria-label': 'Find a neighborhood', style: { width: '160px' },
    oninput: () => { const q = find.value.trim().toLowerCase(); document.querySelectorAll('[data-nbhd-row]').forEach(row => { row.hidden = Boolean(q) && !row.dataset.nbhdRow.includes(q); }); } });
  const list = h('div', { class: 'list list--boxed' }, data.neighborhoods.map(n => {
    const assigned = data.assignments.filter(a => a.neighborhoodId === n.id);
    const who = assigned.length ? [...new Set(assigned.map(a => repName(a.repKey)))].join(', ') : 'unassigned';
    const sub = n.status === 'hold' ? `On hold · ${n.holdReason || 'no reason given'}` : `${(n.importedCount || 0).toLocaleString('en-US')} houses · ${knockedBy.get(n.id) ?? 0} knocked · ${who}`;
    return h('a', { class: `list-row${n.id === selected.id ? ' list-row--now' : ''}`, href: `#admin?s=territory&sel=${encodeURIComponent(n.id)}`, 'data-nbhd-row': n.name.toLowerCase() },
      h('span', { class: 'list-row__main' }, h('span', { class: 'list-row__title' }, n.name), h('span', { class: 'list-row__sub' }, sub)),
      n.tier === 'Premium' ? badge('Premium', 'navy') : badge(n.tier || 'Volume'),
      n.status === 'hold' ? badge('On hold', 'warning') : badge('Open', 'success'));
  }));
  return {
    subtitle: `${data.neighborhoods.length} neighborhoods · ${totalHouses.toLocaleString('en-US')} houses loaded`,
    body: h('div', { class: 'cols cols--wide' },
      h('section', { class: 'stack' }, h('div', { class: 'row row--between wrap' }, h('h2', { style: { fontSize: '20px' } }, 'Neighborhoods'), find), list),
      h('section', { class: 'stack' }, neighborhoodCard(selected, run), await assignCard(selected, data, run), noKnockCard(run))),
  };
}

function neighborhoodCard(n, run) {
  const reason = h('input', { class: 'input', id: 'hold-reason', placeholder: 'e.g. HOA asked for a pause', value: n.holdReason || '' });
  return h('div', { class: 'card', style: { gap: '14px' } },
    h('div', { class: 'row row--between wrap' },
      h('div', {}, h('h2', {}, n.name), h('p', { class: 'caption muted' }, `${(n.importedCount || 0).toLocaleString('en-US')} houses imported · ${n.plattedCount || '?'} platted lots${n.unitCount ? ` · ${n.unitCount} unit addresses` : ''}`)),
      h('div', { style: { width: '200px' } }, seg([['Premium', 'Premium'], ['Volume', 'Volume']], n.tier === 'Premium' ? 'Premium' : 'Volume',
        tier => { if (tier !== n.tier) run({ action: 'neighborhood.update', id: n.id, changes: { tier } }, `${n.name} is ${tier}`); }, { label: 'Tier' }))),
    h('label', { class: 'toggle' }, h('span', {}, 'Open for knocking'),
      h('input', { type: 'checkbox', checked: n.status !== 'hold', onchange: e => run({ action: 'neighborhood.update', id: n.id, changes: e.target.checked ? { status: 'open' } : { status: 'hold', holdReason: reason.value.trim() || 'Held by admin' } }, e.target.checked ? 'Open for knocking' : 'On hold') }),
      h('span', { class: 'toggle__switch', 'aria-hidden': 'true' })),
    field(h('span', {}, 'If on hold, why? ', h('span', { class: 'muted', style: { fontWeight: '400' } }, '(reps see this)')), reason, null, 'hold-reason'),
    n.status === 'hold' ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => run({ action: 'neighborhood.update', id: n.id, changes: { status: 'hold', holdReason: reason.value.trim() || 'Held by admin' } }, 'Reason saved') }, 'Save reason') : null,
    n.jurisdictionHoldCount ? banner('info', 'info', `${n.jurisdictionHoldCount} addresses sit outside this town`, 'They stay locked for reps.') : null,
    h('div', { class: 'row wrap', style: { gap: '10px' } },
      n.unitCount ? h('button', { type: 'button', class: 'btn btn--quiet btn--sm', onclick: () => run({ action: 'neighborhood.excludeUnits', neighborhoodId: n.id, excluded: true }, 'Unit addresses excluded') }, `Exclude ${n.unitCount} unit addresses`) : null,
      h('a', { class: 'btn btn--quiet btn--sm', href: `#admin?s=territory&n=${encodeURIComponent(n.id)}` }, 'See every house', icon('chevronRight', { size: 'sm' }))));
}

async function assignCard(n, data, run) {
  const reps = data.reps.filter(r => r.status === 'active');
  const assigned = data.assignments.filter(a => a.neighborhoodId === n.id);
  const repName = key => data.reps.find(r => r.repKey === key)?.displayName || key;
  let streets = [];
  try {
    const houses = await load('neighborhood', { id: n.id });
    const counts = new Map();
    for (const house of houses.houses) counts.set(house.street, (counts.get(house.street) || 0) + 1);
    streets = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  } catch { /* The whole-neighborhood choice still works. */ }
  let mode = 'whole';
  const rep = h('select', { class: 'input', id: 'assign-rep' }, reps.map(r => h('option', { value: r.repKey }, `${r.displayName}${r.role === 'lead' ? ' (lead)' : ''}`)));
  const picked = new Set();
  const streetBox = h('div', { class: 'stack stack--tight', hidden: true, style: { maxHeight: '320px', overflowY: 'auto' } },
    streets.map(([street, count]) => h('label', { class: 'check check--sm' },
      h('input', { type: 'checkbox', onchange: e => { if (e.target.checked) picked.add(street); else picked.delete(street); } }),
      titleStreet(street), h('span', { class: 'muted', style: { fontWeight: '400' } }, ` · ${count}`))));
  const modeBox = h('div', {});
  const mountMode = () => modeBox.replaceChildren(seg([['whole', 'Whole neighborhood'], ['streets', 'Single streets']], mode, key => { mode = key; streetBox.hidden = key !== 'streets'; mountMode(); }, { label: 'What to assign' }));
  mountMode();
  return h('div', { class: 'card', style: { gap: '12px' } },
    h('h3', {}, 'Assign'),
    reps.length ? [
      field('Rep', rep, null, 'assign-rep'), modeBox, streetBox,
      h('button', { type: 'button', class: 'btn btn--primary', onclick: async () => {
        if (mode === 'streets' && !picked.size) return toast('Pick at least one street.', { tone: 'bad' });
        const targets = mode === 'whole' ? [''] : [...picked];
        for (const street of targets) await action({ action: 'assignment.set', repKey: rep.value, neighborhoodId: n.id, street, active: true }, { quiet: true }).catch(error => toast(error.message, { tone: 'bad' }));
        toast('Assigned', { sub: `${repName(rep.value)} · ${mode === 'whole' ? n.name : `${targets.length} street${targets.length === 1 ? '' : 's'}`}` });
        invalidate('territory'); invalidate('coverage'); app.render();
      } }, 'Save assignment'),
    ] : h('p', { class: 'muted' }, 'Approve a rep first.'),
    assigned.length ? h('div', { class: 'list list--boxed' }, assigned.map(a => h('div', { class: 'list-row list-row--static' },
      h('span', { class: 'list-row__main' }, h('span', { class: 'list-row__title' }, repName(a.repKey)), h('span', { class: 'list-row__sub' }, a.street ? titleStreet(a.street) : 'Whole neighborhood')),
      h('button', { type: 'button', class: 'btn btn--danger btn--sm', onclick: () => run({ action: 'assignment.set', repKey: a.repKey, neighborhoodId: a.neighborhoodId, street: a.street, active: false }, 'Unassigned') }, 'Remove'))))
      : h('p', { class: 'caption muted' }, 'Nobody is assigned here yet.'));
}

function noKnockCard(run) {
  const text = h('textarea', { class: 'input input--area', id: 'noknock', style: { fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: '15px' }, placeholder: 'One address per line' });
  const result = h('div', {});
  return h('div', { class: 'card', style: { gap: '12px' } },
    h('h3', {}, 'City no-knock list'),
    h('p', { class: 'caption muted' }, 'Houses on the City list never show as knockable again. Reps flag no-soliciting signs from the door.'),
    field('Paste the City\'s list', text, null, 'noknock'),
    result,
    h('div', { class: 'row', style: { gap: '10px' } },
      h('button', { type: 'button', class: 'btn btn--secondary', onclick: async () => {
        try {
          const preview = await action({ action: 'noknock.import', text: text.value, apply: false }, { quiet: true });
          mount(result, banner('info', 'info', `Preview · ${preview.matched + preview.unmatched.length} addresses`,
            `${preview.matched} house${preview.matched === 1 ? '' : 's'} will turn red for reps.${preview.unmatched.length ? ` ${preview.unmatched.length} line${preview.unmatched.length === 1 ? '' : 's'} can't be matched and will be skipped: ${preview.unmatched.slice(0, 8).join('; ')}${preview.unmatched.length > 8 ? '; …' : ''}` : ''}`));
        } catch (error) { toast(error.message, { tone: 'bad' }); }
      } }, 'Preview'),
      h('button', { type: 'button', class: 'btn btn--primary', onclick: async () => {
        const applied = await run({ action: 'noknock.import', text: text.value, apply: true, requestId: uuid() }, 'No-knock list applied');
        if (applied) mount(result, banner('success', 'check', `${applied.matched} houses blocked`, `${applied.unmatched.length} lines didn't match a house.`));
      } }, 'Apply'),
      h('button', { type: 'button', class: 'btn btn--quiet', onclick: () => { text.value = ''; mount(result); } }, 'Clear')));
}

async function neighborhoodHousesSection(id, params) {
  const data = await load('neighborhood', { id }, { force: true });
  const houses = data.houses.sort((a, b) => a.street.localeCompare(b.street) || Number(a.number) - Number(b.number) || String(a.unit).localeCompare(String(b.unit)));
  const units = houses.filter(x => x.hasUnit);
  const refresh = () => { invalidate('neighborhood'); app.render(); };
  const toggle = async (house, excluded) => {
    try { await action({ action: 'house.exclude', houseIds: [house.id], excluded }, { quiet: true }); toast(excluded ? 'Excluded' : 'Included', { sub: `${house.number} ${titleStreet(house.street)}` }); refresh(); }
    catch (error) { toast(error.message, { tone: 'bad' }); }
  };
  const clearNoKnock = async house => {
    try { await action({ action: 'noknock.clear', houseId: house.id }, { quiet: true }); toast('Taken off the no-knock list'); refresh(); }
    catch (error) { toast(error.message, { tone: 'bad' }); }
  };
  const filter = params.get('f') || 'units';
  const shown = filter === 'units' ? units : filter === 'blocked' ? houses.filter(x => x.noKnock) : houses;
  return {
    title: h('a', { class: 'link row', href: `#admin?s=territory&sel=${encodeURIComponent(id)}`, style: { gap: '6px', textDecoration: 'none' } }, icon('chevronLeft'), h('h1', {}, data.neighborhood.name)),
    subtitle: `${houses.length} houses · ${units.length} with unit numbers · ${houses.filter(x => x.excluded).length} excluded · ${houses.filter(x => x.noKnock).length} no-knock`,
    body: [
      chips([['units', 'Unit addresses'], ['blocked', 'No-knock'], ['all', 'All houses']], filter, key => go('territory', { n: id, f: key }), { label: 'Filter houses' }),
      shown.length ? h('div', { class: 'list list--boxed' }, shown.slice(0, 600).map(house => h('div', { class: 'list-row list-row--static' },
        dot(house.noKnock ? 'blocked' : house.summary?.lastOutcome || 'none', { large: true }),
        h('span', { class: 'list-row__main' }, h('span', { class: 'list-row__title' }, `${house.number} ${titleStreet(house.street)}${house.unit ? ` #${house.unit}` : ''}`),
          h('span', { class: 'list-row__sub' }, [house.hasUnit ? 'unit address' : '', house.excluded ? 'excluded' : '', house.noKnock ? `no-knock (${house.noKnock.source})` : '', house.jurisdictionHold ? 'other town' : '', house.summary?.lastOutcome ? `last: ${house.summary.lastOutcome.replace('_', ' ')}` : ''].filter(Boolean).join(' · ') || 'Not knocked')),
        house.noKnock?.source === 'city' ? h('button', { type: 'button', class: 'btn btn--quiet btn--sm', onclick: () => clearNoKnock(house) }, 'Clear') : null,
        h('button', { type: 'button', class: `btn btn--sm ${house.excluded ? 'btn--secondary' : 'btn--danger'}`, onclick: () => toggle(house, !house.excluded) }, house.excluded ? 'Include' : 'Exclude'))))
        : emptyState('check', 'Nothing here', 'Try another filter.'),
      shown.length > 600 ? h('p', { class: 'caption muted' }, `Showing the first 600 of ${shown.length}.`) : null,
    ],
  };
}

/* ---------- Coverage ---------- */

async function coverageSection(params) {
  const { coverage } = await load('coverage', {}, { force: true });
  const rows = coverage.filter(n => n.total);
  const total = rows.reduce((sum, n) => sum + n.total, 0), knocked = rows.reduce((sum, n) => sum + n.knocked, 0);
  const now = [];
  for (const n of coverage) {
    const seen = new Set();
    for (const s of n.streets) for (const name of s.hereNow) if (!seen.has(name)) { seen.add(name); now.push({ name, where: `${n.name} · ${titleStreet(s.street)}`, last: s.lastKnockedAt }); }
    for (const name of n.hereNow) if (!seen.has(name)) { seen.add(name); now.push({ name, where: n.name, last: n.lastKnockedAt }); }
  }
  const selected = rows.find(n => n.id === params.get('n')) || [...rows].sort((a, b) => b.knocked - a.knocked)[0];
  const pick = h('select', { class: 'input input--sm', 'aria-label': 'Neighborhood', style: { width: '220px' }, onchange: e => go('coverage', { n: e.target.value }) },
    rows.map(n => h('option', { value: n.id, selected: n.id === selected?.id }, n.name)));
  return {
    subtitle: `${knocked.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} houses knocked · ${total ? Math.round(knocked / total * 100) : 0}%`,
    body: [
      h('section', { class: 'card', style: { gap: '12px' } },
        h('div', { class: 'row row--between' }, h('h2', { style: { fontSize: '20px' } }, 'Knocking right now'),
          now.length ? h('span', { class: 'badge badge--success' }, h('span', { class: 'sync__dot', style: { background: 'var(--success)' } }), `${now.length} on the clock`) : badge('Nobody right now')),
        now.length ? h('div', { class: 'cols', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: '10px' } }, now.map(r => h('div', { class: 'card card--line', style: { gap: '4px', padding: '12px' } },
          h('b', {}, r.name), h('span', { class: 'caption muted' }, r.where), r.last ? h('span', { class: 'caption' }, `Last door ${timeLabel(r.last)}`) : null)))
          : h('p', { class: 'caption muted' }, 'Reps show here while they knock.')),
      h('div', { class: 'cols cols--wide' },
        h('section', { class: 'card', style: { gap: '14px' } },
          h('h2', { style: { fontSize: '20px' } }, 'By neighborhood'),
          rows.length ? [...rows].sort((a, b) => b.percent - a.percent || a.name.localeCompare(b.name)).map(n => h('a', { href: `#admin?s=coverage&n=${encodeURIComponent(n.id)}`, style: { textDecoration: 'none', color: 'inherit', opacity: n.status === 'hold' ? '.6' : null } },
            meter({ label: h('span', {}, n.name, n.status === 'hold' ? h('span', { class: 'muted' }, ' · on hold') : null), value: `${n.percent}% · ${n.knocked} / ${n.total}`, ratio: n.percent / 100, tone: n.percent >= 90 ? 'success' : '' })))
            : h('p', { class: 'muted' }, 'No houses loaded yet.')),
        selected ? h('section', { class: 'card', style: { gap: '14px' } },
          h('div', { class: 'row row--between wrap' }, h('h2', { style: { fontSize: '20px' } }, `${selected.name} · by street`), pick),
          h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Street'), h('th', {}, 'Knocked'), h('th', { style: { width: '40%' } }, ''), h('th', {}, 'Who'))),
            h('tbody', {}, [...selected.streets].sort((a, b) => b.percent - a.percent || a.street.localeCompare(b.street)).map(s => h('tr', {},
              h('td', {}, h('b', {}, titleStreet(s.street))), h('td', { class: 'mono' }, `${s.knocked} / ${s.total}`),
              h('td', {}, h('div', { class: 'meter__bar' }, h('div', { class: `meter__fill${s.percent >= 90 ? ' meter__fill--success' : ''}`, style: { width: `${s.percent}%` } }))),
              h('td', { class: 'caption' }, s.hereNow.length ? `${s.hereNow.join(', ')} · now` : s.lastKnockedAt ? `last ${timeLabel(s.lastKnockedAt)}` : h('span', { class: 'muted' }, 'nobody'))))))),
          h('p', { class: 'caption muted' }, 'Excluded houses and City no-knock houses are left out of the totals.')) : null),
    ],
  };
}

/* ---------- Sales ---------- */

const SALE_BADGE = { booked: ['Booked', 'info'], completed: ['Completed', 'success'], paid: ['Paid', 'success'], cancelled: ['Cancelled', 'error'] };

function needsMe(sale, highLevel) {
  if (!['booked', 'completed'].includes(sale.status)) return false;
  const d = sale.handoff?.deposit || {}, t = sale.handoff?.text || {}, j = sale.handoff?.job || {};
  return j.status !== 'created' || d.status !== 'collected' || (sale.textConsent && t.status !== 'sent') || sale.status === 'completed' || (highLevel && t.status === 'uncertain');
}

async function salesSection(params) {
  const data = await load('sales', {}, { force: true });
  const filter = params.get('f') || 'needs';
  const ready = (status, key) => status.mode === key && status.available.includes(key);
  const stripe = ready(data.integrations.deposit, 'stripe');
  const highLevel = ready(data.integrations.text, 'highlevel');
  const why = (kind, key, name) => ready(data.integrations[kind], key) ? `${name} or by hand`
    : !data.integrations[kind].available.includes(key) ? `by hand (${name} isn't set up on the server)` : `by hand (choose ${key} in Settings to use ${name})`;
  const repName = key => data.reps.find(r => r.repKey === key)?.displayName || key;
  const shown = data.sales.filter(s => filter === 'all' ? true : filter === 'needs' ? needsMe(s, highLevel) : filter === 'booked' ? s.status === 'booked' : ['completed', 'paid', 'cancelled'].includes(s.status));
  const open = shown.find(s => s.id === params.get('sale')) || shown[0];
  const refresh = () => { invalidate('sales'); app.render(); };
  const act = async (body, message) => {
    try { await action(body, { quiet: true }); toast(message); refresh(); }
    catch (error) { toast(error.message, { tone: 'bad' }); if (error.details?.sale) refresh(); }
  };
  const address = sale => `${sale.address.number} ${titleStreet(sale.address.street)}${sale.address.unit ? ` #${sale.address.unit}` : ''}`;
  const card = sale => {
    const d = sale.handoff?.deposit || {}, t = sale.handoff?.text || {}, j = sale.handoff?.job || {};
    const ref = h('input', { class: 'input input--sm', placeholder: 'Hub job ID or Jobber link', value: j.ref || '', 'aria-label': 'Job reference' });
    const windowOpen = Date.now() < Date.parse(sale.cancelEndsAt || 0);
    const [label, tone] = SALE_BADGE[sale.status] || [sale.status, ''];
    return h('section', { class: 'card card--accent', style: { gap: '14px' } },
      h('div', { class: 'row row--between row--top wrap' },
        h('div', { class: 'stack stack--tight' },
          h('div', { class: 'row', style: { gap: '8px' } }, dot('sold', { large: true }), h('h2', {}, `${sale.customer.name} · ${money(sale.ticket)}`)),
          h('span', { class: 'muted' }, `${address(sale)} · ${sale.package} · sold ${timeLabel(sale.soldAt)} by ${repName(sale.repKey)} · job ${dateLabel(sale.jobDate)}${sale.jobStartTime ? `, ${wallTime(sale.jobStartTime)}` : ''}`),
          h('span', { class: 'caption' }, h('a', { href: `tel:${sale.customer.phone}` }, phoneLabel(sale.customer.phone)), ' · ', h('a', { href: `mailto:${sale.customer.email}` }, sale.customer.email))),
        h('div', { class: 'row wrap', style: { gap: '6px' } }, badge(label, tone), sale.status === 'booked' ? badge(windowOpen ? `Refund window to ${dateLabel(sale.cancelDeadlineDate)}` : 'Refund window closed', windowOpen ? 'warning' : '') : null)),
      h('div', { class: 'handoffs' },
        h('div', { class: 'card card--line', style: { gap: '10px' } },
          h('div', { class: 'row row--between' }, h('h3', {}, '1 · Job'), j.status === 'created' ? badge('Created', 'success', 'check') : badge('Not created', 'warning')),
          j.ref ? kv('Reference', j.ref) : null, ref,
          h('button', { type: 'button', class: 'btn btn--quiet btn--sm', onclick: () => act({ action: 'sale.handoff', saleId: sale.id, kind: 'job', op: 'mark', ref: ref.value }, 'Job marked created') }, j.status === 'created' ? 'Update reference' : 'Mark created')),
        h('div', { class: 'card card--line', style: { gap: '10px' } },
          h('div', { class: 'row row--between' }, h('h3', {}, `2 · Deposit · ${money(sale.depositAmount, sale.depositAmount % 1 !== 0)}`),
            d.status === 'collected' ? badge('Collected', 'success', 'check') : d.url ? badge('Link sent', 'warning') : badge('Not paid')),
          d.url && d.status !== 'collected' ? h('p', { class: 'caption muted' }, h('a', { href: d.url, target: '_blank', rel: 'noopener' }, 'Stripe payment link'), d.lastCheckedAt ? ` · checked ${timeLabel(d.lastCheckedAt)}` : ' · not paid yet') : null,
          d.url && d.status !== 'collected' ? h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => act({ action: 'sale.handoff', saleId: sale.id, kind: 'deposit', op: 'refresh' }, 'Checked with Stripe') }, 'Check payment') : null,
          stripe && d.status !== 'collected' && !d.url ? h('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: () => act({ action: 'sale.handoff', saleId: sale.id, kind: 'deposit', op: 'start' }, 'Stripe link created') }, 'Create Stripe link') : null,
          d.status !== 'collected' ? h('button', { type: 'button', class: 'btn btn--quiet btn--sm', onclick: () => act({ action: 'sale.handoff', saleId: sale.id, kind: 'deposit', op: 'mark' }, 'Deposit marked collected') }, 'Mark collected (cash or check)') : null),
        h('div', { class: 'card card--line', style: { gap: '10px' } },
          h('div', { class: 'row row--between' }, h('h3', {}, '3 · Customer text'),
            t.status === 'sent' ? badge('Sent', 'success', 'check') : t.status === 'uncertain' ? badge('Check HighLevel', 'warning') : badge(sale.textConsent ? 'Not sent' : 'No consent')),
          h('p', { class: 'caption muted' }, sale.textConsent ? `Receipt and cancel-by date to ${phoneLabel(sale.customer.phone)} · customer said OK to text` : 'The customer didn\'t agree to a text. Don\'t text them.'),
          highLevel && sale.textConsent && !['sent', 'uncertain', 'sending'].includes(t.status) ? h('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: async () => {
            if (await confirmSheet('Send one text?', sale.message, 'Send text')) act({ action: 'sale.handoff', saleId: sale.id, kind: 'text', op: 'send' }, 'Text sent');
          } }, 'Send via HighLevel') : null,
          t.status !== 'sent' && sale.textConsent ? h('button', { type: 'button', class: 'btn btn--quiet btn--sm', onclick: () => act({ action: 'sale.handoff', saleId: sale.id, kind: 'text', op: 'mark' }, 'Text marked sent') }, 'Mark sent (sent by hand)') : null,
          t.error ? h('p', { class: 'error-text' }, icon('alert', { size: 'sm' }), t.error) : null,
          h('details', {}, h('summary', { class: 'caption' }, 'See the text'), h('p', { class: 'caption', style: { marginTop: '6px' } }, sale.message)))),
      lifecycle(sale, act),
      h('p', { class: 'caption muted' }, `Deposit ${why('deposit', 'stripe', 'Stripe')}; customer text ${why('text', 'highlevel', 'HighLevel')}. ${sale.refund} Checklist confirmed ${timeLabel(sale.checklistConfirmedAt)}.`));
  };
  const nextLabel = sale => {
    const d = sale.handoff?.deposit || {}, t = sale.handoff?.text || {}, j = sale.handoff?.job || {};
    if (sale.status === 'cancelled' || sale.status === 'paid') return '';
    if (j.status !== 'created') return 'Create job';
    if (d.status !== 'collected') return 'Deposit';
    if (sale.textConsent && t.status !== 'sent') return 'Text';
    return sale.status === 'completed' ? 'Mark paid' : 'Job day';
  };
  return {
    subtitle: 'One customer at a time. Every text goes to one person, never a batch.',
    actions: h('div', { style: { width: '420px', maxWidth: '100%' } }, seg([['needs', 'Needs me'], ['booked', 'Booked'], ['done', 'Done'], ['all', 'All']], filter, key => go('sales', { f: key }), { label: 'Filter sales' })),
    body: [
      open ? card(open) : emptyState('dollar', filter === 'needs' ? 'Nothing needs you' : 'No sales here', filter === 'needs' ? 'New sales show up here with their hand-offs.' : 'Try another filter.'),
      shown.length > 1 ? h('div', { class: 'card card--line table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ['Customer', 'Rep', 'Job', 'Deposit', 'Text', 'Status', 'Next'].map(label => h('th', {}, label)))),
        h('tbody', {}, shown.filter(s => s !== open).map(sale => {
          const d = sale.handoff?.deposit || {}, t = sale.handoff?.text || {}, j = sale.handoff?.job || {};
          const [label, tone] = SALE_BADGE[sale.status] || [sale.status, ''];
          const next = nextLabel(sale);
          return h('tr', {},
            h('td', {}, h('b', {}, sale.customer.name), h('div', { class: 'caption muted' }, `${money(sale.ticket)} · ${sale.package}`)),
            h('td', {}, repName(sale.repKey)),
            h('td', {}, j.status === 'created' ? `${j.ref || 'Created'} · ${dateLabel(sale.jobDate)}` : badge('Not created', 'warning')),
            h('td', {}, d.status === 'collected' ? badge('Collected', 'success') : d.url ? badge('Link sent', 'warning') : badge('None')),
            h('td', {}, t.status === 'sent' ? badge('Sent', 'success') : badge(sale.textConsent ? 'Not sent' : 'No consent')),
            h('td', {}, badge(label, tone)),
            h('td', {}, next ? h('a', { class: 'btn btn--secondary btn--sm', href: `#admin?s=sales&f=${filter}&sale=${encodeURIComponent(sale.id)}` }, `${next}…`) : h('span', { class: 'muted' }, 'Nothing')));
        })))) : null,
    ],
  };
}

function lifecycle(sale, act) {
  const paid = h('input', { class: 'input input--sm', type: 'number', step: '0.01', min: '0', value: String(sale.collectedAmount ?? sale.ticket), 'aria-label': 'Amount collected', style: { width: '9rem' } });
  const jobDate = h('input', { class: 'input input--sm', type: 'date', value: sale.jobDate, min: sale.earliestJobDate, 'aria-label': 'Job date', style: { width: '11rem' } });
  return h('div', { class: 'card card--line', style: { gap: '10px' } },
    h('h3', {}, 'Lifecycle'),
    h('div', { class: 'row wrap', style: { gap: '10px' } },
      sale.status === 'booked' ? h('button', { type: 'button', class: 'btn btn--success btn--sm', onclick: () => act({ action: 'sale.status', saleId: sale.id, status: 'completed' }, 'Marked completed') }, icon('check'), 'Job completed') : null,
      ['booked', 'completed'].includes(sale.status) ? h('span', { class: 'row', style: { gap: '6px' } }, paid,
        h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => act({ action: 'sale.status', saleId: sale.id, status: 'paid', collectedAmount: paid.value }, 'Marked paid') }, 'Mark paid')) : null,
      sale.status !== 'cancelled' ? h('span', { class: 'row', style: { gap: '6px' } }, jobDate,
        h('button', { type: 'button', class: 'btn btn--quiet btn--sm', onclick: () => act({ action: 'sale.jobDate', saleId: sale.id, jobDate: jobDate.value }, 'Job date saved') }, 'Move job')) : null,
      h('span', { class: 'spacer' }),
      sale.status !== 'cancelled'
        ? h('button', { type: 'button', class: 'btn btn--danger btn--sm', onclick: async () => {
          if (await confirmSheet('Cancel this sale?', 'A cancelled sale pays no commission. Refund the deposit by the cancellation rules.', 'Cancel sale', 'danger')) act({ action: 'sale.status', saleId: sale.id, status: 'cancelled' }, 'Sale cancelled');
        } }, 'Cancel sale…')
        : h('button', { type: 'button', class: 'btn btn--secondary btn--sm', onclick: () => act({ action: 'sale.status', saleId: sale.id, status: 'booked' }, 'Sale reinstated') }, 'Reinstate')),
    h('p', { class: 'caption muted' }, `The job can't be before ${dateLabel(sale.earliestJobDate)}. Commission is earned once the job is completed, paid and past the cancellation deadline.`));
}

/* ---------- Money ---------- */

async function moneySection(params) {
  const date = params.get('date') || zonedDate(Date.now());
  const data = await load('money', { date }, { force: true });
  const period = data.period;
  const exportCsv = async kind => {
    try {
      const file = await app.api(`/api/knock-admin?view=export&kind=${kind}&date=${encodeURIComponent(period.start)}`);
      downloadText(file.filename, file.csv);
    } catch (error) { toast(error.message, { tone: 'bad' }); }
  };
  const total = key => data.statement.reduce((sum, r) => sum + Number(r[key] || 0), 0);
  const owed = total('balance');
  return {
    title: h('div', { class: 'row', style: { gap: '12px' } },
      h('a', { class: 'btn btn--secondary btn--sm', href: `#admin?s=money&date=${encodeURIComponent(data.previous.start)}`, 'aria-label': 'Previous pay period', style: { padding: '0 10px' } }, icon('chevronLeft')),
      h('div', {}, h('h1', {}, periodLabel(period.start, period.end)), h('p', { class: 'muted' }, `Pay period · ${{ weekly: 'weekly', biweekly: 'every 2 weeks', semimonthly: '1st & 16th', monthly: 'monthly' }[data.payroll.period] || data.payroll.period}`)),
      h('a', { class: 'btn btn--secondary btn--sm', href: `#admin?s=money&date=${encodeURIComponent(data.next.start)}`, 'aria-label': 'Next pay period', style: { padding: '0 10px' } }, icon('chevronRight'))),
    actions: [['commission', 'Commission CSV'], ['training', 'Training CSV'], ['sales', 'Sales CSV']].map(([kind, label]) =>
      h('button', { type: 'button', class: 'btn btn--quiet btn--sm', onclick: () => exportCsv(kind) }, icon('download', { size: 'sm' }), label)),
    body: [
      h('div', { class: 'stats stats--4' },
        stat('Sales booked', String(total('salesBooked')), { sub: `${money(total('booked'))} commission booked` }),
        stat('Commission earned', money(total('earned') + total('override')), { sub: `${data.statement.filter(r => r.earned || r.override).length} reps` }),
        h('div', { class: 'stat' }, h('span', { class: 'stat__label' }, 'Still to pay'), h('span', { class: 'stat__value', style: { color: owed > 0 ? 'var(--warning)' : 'var(--success)' } }, money(owed)), h('span', { class: 'stat__sub' }, 'earned minus paid')),
        stat('Training hours', `${number(total('trainingMinutes') / 60, 1)} h`, { sub: `${money(total('trainingPay'), true)} · paid separately` })),
      h('p', { class: 'caption muted' }, `Commission ${percent(data.rates.rate)} of collected revenue once a job is completed, paid and past its cancellation deadline${data.rates.acceleratorEnabled ? `; ${percent(data.rates.acceleratorRate)} above ${money(data.rates.acceleratorThreshold)} collected in a month` : ''}${data.rates.leadOverrideEnabled ? `; leads get ${percent(data.rates.leadOverrideRate, 1)} of their team` : ''}. Training ${money(data.trainingHourlyRate, true)}/h.`),
      h('div', { class: 'card card--line table-wrap' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, ['Rep', 'Booked', 'Earned', 'Paid', 'Owed', 'Training', ''].map((label, i) => h('th', { class: i && i < 6 ? 'num' : '' }, label)))),
        h('tbody', {}, data.statement.length ? data.statement.map(row => h('tr', {},
          h('td', {}, h('b', {}, row.name), row.override ? h('div', { class: 'caption muted' }, `includes ${money(row.override, true)} lead bonus`) : null),
          h('td', { class: 'num' }, money(row.booked)), h('td', { class: 'num' }, money(row.earned + row.override, true)), h('td', { class: 'num' }, money(row.paid, true)),
          h('td', { class: 'num' }, h('b', { style: { color: row.balance > 0 ? 'var(--warning)' : 'var(--success)' } }, money(row.balance, true))),
          h('td', { class: 'num' }, row.trainingMinutes ? `${hoursLabel(row.trainingMinutes * 60000)} h` : '–'),
          h('td', {}, row.balance > 0 ? h('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: () => payoutSheet(row, period) }, 'Record payout…') : row.paid > 0 ? badge('Paid', 'success') : null))) : h('tr', {}, h('td', { colspan: '7', class: 'muted' }, 'Nothing earned in this period yet.'))))),
      data.payouts.length ? h('section', { class: 'stack stack--tight' }, h('h2', { style: { fontSize: '18px' } }, 'Payouts recorded'),
        h('div', { class: 'list list--boxed' }, data.payouts.map(p => h('div', { class: 'list-row list-row--static' },
          h('span', { class: 'list-row__main' }, h('span', { class: 'list-row__title' }, `${data.statement.find(r => r.repKey === p.repKey)?.name || p.repKey} · ${money(p.amount, true)}`), h('span', { class: 'list-row__sub' }, [p.note, p.at ? timeLabel(p.at) : ''].filter(Boolean).join(' · '))))))) : null,
      h('p', { class: 'caption muted' }, 'Payouts can\'t be deleted, only reversed with a second entry, so the CSV always matches the books.'),
    ],
  };
}

function payoutSheet(row, period) {
  return sheet('Record a payout', close => {
    let how = 'Payroll';
    const amount = h('input', { class: 'input', id: 'po-amount', type: 'number', step: '0.01', min: '0', inputmode: 'decimal', value: String(row.balance) });
    const note = h('input', { class: 'input', id: 'po-note', placeholder: 'e.g. Gusto run #214' });
    const howBox = h('div', {});
    const mountHow = () => howBox.replaceChildren(seg([['Payroll', 'Payroll'], ['Transfer', 'Transfer'], ['Check', 'Check']], how, key => { how = key; mountHow(); }, { label: 'How' }));
    mountHow();
    return [
      field('Amount', amount, `Owed ${money(row.balance, true)} for ${periodLabel(period.start, period.end)}`, 'po-amount'),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'How'), howBox),
      field(h('span', {}, 'Note ', h('span', { class: 'muted', style: { fontWeight: '400' } }, '(optional)')), note, null, 'po-note'),
      h('button', { type: 'button', class: 'btn btn--primary btn--block', onclick: async () => {
        try {
          await action({ action: 'payout.add', requestId: uuid(), repKey: row.repKey, periodKey: period.key, amount: Number(amount.value), note: [how, note.value.trim()].filter(Boolean).join(' · ') }, { quiet: true });
          toast(`Recorded ${money(Number(amount.value), true)}`, { sub: row.name });
          close(true); invalidate('money'); app.render();
        } catch (error) { toast(error.message, { tone: 'bad' }); }
      } }, `Record payout to ${row.name.split(' ')[0]}`),
    ];
  }, { subtitle: row.name });
}

/* ---------- Flags ---------- */

async function flagsSection() {
  const data = await load('flags', {}, { force: true });
  const late = data.flags.filter(f => f.flags.includes('after_sunset'));
  const other = data.flags.filter(f => !f.flags.includes('after_sunset'));
  const flagCard = flag => h('div', { class: 'card card--line', style: { gap: '8px' } },
    h('div', { class: 'row row--between row--top wrap' },
      h('div', { class: 'row row--top', style: { gap: '10px' } }, dot(flag.outcome || 'none', { large: true }),
        h('div', {}, h('b', {}, `${flag.address || flag.type}${flag.outcome ? ` · ${flag.outcome.replace('_', ' ')}` : ''}`),
          h('div', { class: 'caption muted' }, `${flag.rep} · ${timeLabel(flag.at)}`))),
      h('div', { class: 'row wrap', style: { gap: '6px' } }, flag.flags.map(f => badge(data.labels[f] || f, f === 'after_sunset' ? 'error' : 'warning')))));
  return {
    subtitle: data.flags.length ? `${data.flags.length} thing${data.flags.length === 1 ? '' : 's'} to review with the rep` : 'Nothing needs a look',
    body: data.flags.length ? [
      late.length ? h('section', { class: 'flag-group' }, h('div', { class: 'list-head', style: { position: 'static', background: 'none', border: 0, padding: '0' } }, 'Logged after sunset'), late.map(flagCard),
        h('p', { class: 'caption muted' }, 'After sunset a rep may finish the door they were at for a few minutes; it is recorded and flagged here.')) : null,
      other.length ? h('section', { class: 'flag-group' }, h('div', { class: 'list-head', style: { position: 'static', background: 'none', border: 0, padding: '0' } }, 'Other things to check'), other.map(flagCard)) : null,
    ] : emptyState('flag', 'Nothing needs a look. Nice.', 'Doors logged after sunset, outside the hours, on a City no-knock house or on an excluded house show up here.'),
  };
}

/* ---------- Scoreboard ---------- */

async function scoreboardSection(params) {
  const { scoreboardBody } = await import('./knock-stats-ui.js');
  const rangeKey = params.get('range') || 'week', groupBy = params.get('groupBy') || 'rep';
  const data = await app.api(`/api/knock-reports?view=scoreboard&range=${encodeURIComponent(rangeKey)}&groupBy=${encodeURIComponent(groupBy)}`);
  return {
    subtitle: 'Every rep against the plan, and the Go / Fix / Stop call for the program.',
    body: scoreboardBody(data, {
      onRange: key => go('scoreboard', { range: key, groupBy }),
      onGroup: key => go('scoreboard', { range: rangeKey, groupBy: key }),
    }),
  };
}

/* ---------- Settings ---------- */

const get = (obj, path) => path.split('.').reduce((value, key) => value?.[key], obj);
function put(obj, path, value) {
  const keys = path.split('.');
  let target = obj;
  for (const key of keys.slice(0, -1)) target = target[key] ??= {};
  target[keys.at(-1)] = value;
}

async function settingsSection() {
  const data = await load('settings', {}, { force: true });
  const draft = structuredClone(data.settings);
  const cityKey = Object.keys(draft.cities || {})[0] || 'fort-collins';
  const city = `cities.${cityKey}`;
  const problems = h('div', {});
  // A number input bound to a settings path; scale turns 0.25 into 25 (%).
  const num = (path, { scale = 1, step = 'any', width = '100px', unit = '', prefix = '' } = {}) => {
    const id = `set-${path.replace(/\W/g, '-')}`;
    const input = h('input', { class: 'input', id, type: 'number', step, inputmode: 'decimal', value: String(Math.round(Number(get(draft, path)) * scale * 1000) / 1000), style: { width },
      onchange: e => put(draft, path, Number(e.target.value) / scale) });
    return { id, el: h('div', { class: 'unit-field' }, prefix ? h('span', {}, prefix) : null, input, unit ? h('span', {}, unit) : null) };
  };
  const row = (label, control, hint = null) => h('div', { class: 'field' }, h('label', { class: 'label', for: control.id }, label), control.el, hint ? h('span', { class: 'hint' }, hint) : null);
  const text = (path, { type = 'text', placeholder = '' } = {}) => {
    const id = `set-${path.replace(/\W/g, '-')}`;
    return { id, el: h('input', { class: 'input', id, type, placeholder, value: String(get(draft, path) ?? ''), onchange: e => put(draft, path, e.target.value) }) };
  };
  const toggle = (path, label) => h('label', { class: 'toggle' }, h('span', {}, label),
    h('input', { type: 'checkbox', checked: Boolean(get(draft, path)), onchange: e => put(draft, path, e.target.checked) }), h('span', { class: 'toggle__switch', 'aria-hidden': 'true' }));
  const segFor = (path, options, label) => {
    const box = h('div', {});
    const mountSeg = () => box.replaceChildren(seg(options, get(draft, path), value => { put(draft, path, value); mountSeg(); }, { label }));
    mountSeg();
    return box;
  };
  const today = zonedDate(Date.now());
  const example = cancellationWindow(today, { businessDays: draft.sale.cancelBusinessDays, extraHolidays: draft.sale.extraHolidays });
  const json = (path, label, hint) => {
    const id = `set-${path.replace(/\W/g, '-')}`;
    const value = get(draft, path);
    return h('div', { class: 'field' }, h('label', { class: 'label', for: id }, label),
      h('textarea', { class: 'input input--area', id, style: { fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: '14px' }, rows: String(Math.min(12, JSON.stringify(value, null, 2).split('\n').length + 1)),
        onchange: e => { try { put(draft, path, JSON.parse(e.target.value)); e.target.setCustomValidity(''); } catch { e.target.setCustomValidity('Not valid JSON'); e.target.reportValidity(); } } }, JSON.stringify(value, null, 2)),
      hint ? h('span', { class: 'hint' }, hint) : null);
  };
  const save = async () => {
    try {
      await action({ action: 'settings.update', settings: draft }, { quiet: true });
      toast('Settings saved', { sub: 'They apply to new doors and sales.' });
      invalidate('settings');
      await app.sync({ full: true });
    } catch (error) {
      mount(problems, banner('error', 'alert', error.message, (error.details?.problems || []).join('; ')));
      problems.scrollIntoView({ block: 'center' });
    }
  };
  const card = (title, ...children) => h('section', { class: 'card', style: { gap: '14px' } }, h('h2', {}, title), children);
  return {
    subtitle: `Every rule the app follows, in plain words. Changes apply to new doors and sales, never to old ones. ${data.updatedAt ? `Last saved ${timeLabel(data.updatedAt)} by ${data.updatedBy}.` : 'Using the defaults.'}`,
    actions: [
      h('button', { type: 'button', class: 'btn btn--quiet btn--sm', onclick: () => { invalidate('settings'); app.render(); } }, 'Discard changes'),
      h('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: save }, 'Save settings'),
    ],
    body: [
      problems,
      h('div', { class: 'cols cols--wide' },
        card('Knocking hours',
          h('div', { class: 'fields-2' }, row('Doors open at', text(`${city}.startTime`, { type: 'time' })), row('Sunset offset', num(`${city}.sunsetOffsetMinutes`, { unit: 'min', step: '1' }), 'Doors close at sunset plus this.')),
          row('Warn reps before sunset', num(`${city}.warnMinutes`, { unit: 'minutes', step: '1' })),
          row('After sunset, allow the current door for', num(`${city}.graceMinutes`, { unit: 'minutes · and flag it', step: '1' })),
          row('End a shift after it sits idle for', num('shift.idleAutoEndHours', { unit: 'hours', step: '0.5' })),
          toggle(`${city}.requiresPermit`, 'Reps must be on the City permit list'),
          h('p', { class: 'caption muted' }, `Sunset is worked out for ${get(draft, `${city}.name`) || 'the city'} every day, so it moves with the season on its own.`)),
        card('Deposit & cancellation',
          row('Deposit at the door', num('sale.depositRate', { scale: 100, unit: '% of the price', step: '1' })),
          row('Customer can cancel for a full refund within', num('sale.cancelBusinessDays', { unit: 'business days, until midnight', step: '1' }), 'Sundays and federal holidays don\'t count; Saturdays do.'),
          row('After that, refundable until', num('sale.refundCutoffHours', { unit: 'hours before the job', step: '1' })),
          row('Default job start', text('sale.defaultJobStartTime', { type: 'time' })),
          banner('info', 'info', 'Example', `A sale on ${longDateLabel(today)} can be cancelled until midnight ${longDateLabel(example.deadlineDate)}. The earliest job date is ${longDateLabel(example.earliestJobDate)}.`)),
        card('Commission',
          h('div', { class: 'fields-2' }, row('Base rate', num('commission.rate', { scale: 100, unit: '%', step: '0.5' })), row('Lead gets of their team', num('commission.leadOverrideRate', { scale: 100, unit: '%', step: '0.5' }))),
          toggle('commission.leadOverrideEnabled', 'Leads earn a bonus on their team'),
          h('div', { class: 'fields-2' }, row('Higher rate', num('commission.acceleratorRate', { scale: 100, unit: '%', step: '0.5' })), row('once monthly revenue passes', num('commission.acceleratorThreshold', { prefix: '$', step: '100', width: '120px' }))),
          toggle('commission.acceleratorEnabled', 'Use the higher rate'),
          h('p', { class: 'caption muted' }, 'Commission is earned when the job is completed, paid in full and past the cancellation deadline.'),
          row('Training pay', num('payroll.trainingHourlyRate', { prefix: '$', unit: 'per hour, paid separately', step: '0.01' }))),
        card('Pay period',
          segFor('payroll.period', [['weekly', 'Weekly'], ['biweekly', 'Every 2 weeks'], ['semimonthly', '1st & 16th'], ['monthly', 'Monthly']], 'Pay period'),
          row('Weekly and two-week periods start on', text('payroll.anchorDate', { type: 'date' }), 'A Monday.')),
        card('Plan targets',
          h('p', { class: 'caption muted' }, 'What the Scoreboard compares every rep against.'),
          h('div', { class: 'fields-2' },
            row('Doors / hour', num('plan.doorsPerHour', { step: '0.5', width: '100%' })), row('Answer rate', num('plan.answerRate', { scale: 100, unit: '%', step: '1' })),
            row('Look rate', num('plan.lookRate', { scale: 100, unit: '%', step: '0.5' })), row('Close rate', num('plan.closeRate', { scale: 100, unit: '%', step: '1' })),
            row('Average ticket', num('plan.averageTicket', { prefix: '$', step: '50', width: '100%' })), row('$ booked / hour', num('plan.revenuePerHour', { prefix: '$', step: '1', width: '100%' })))),
        card('Go / Fix / Stop gate',
          h('div', { class: 'fields-2' },
            row('Too early under', num('gate.minimumHours', { unit: 'h', step: '1' })), row('Decide at', num('gate.decisionHours', { unit: 'h', step: '1' })),
            row('Go at $/h of', num('gate.goPerHour', { prefix: '$', step: '1' })), row('Stop under', num('gate.fixPerHour', { prefix: '$', step: '1' })))),
        card('Go-backs',
          h('div', { class: 'fields-2' }, row('Tries per house, per season', num('goBacks.maxAttemptsPerSeason', { step: '1' })), row('"Not interested" rests for', num('goBacks.notInterestedRestMonths', { unit: 'months', step: '1' }))),
          row('Season starts on (MM-DD)', text('goBacks.seasonStart', { placeholder: '01-01' }))),
        card('Integrations',
          h('div', { class: 'field' }, h('span', { class: 'label' }, 'Deposit links'), segFor('integrations.deposit', [['manual', 'By hand'], ['stripe', 'Stripe']], 'Deposit links')),
          h('div', { class: 'field' }, h('span', { class: 'label' }, 'Customer texts'), segFor('integrations.text', [['manual', 'By hand'], ['highlevel', 'HighLevel']], 'Customer texts')),
          h('p', { class: 'caption muted' }, 'Stripe and HighLevel also need their keys on the server; the Sales screen says when one is missing. Before turning on HighLevel texts, check no Contact Created workflow would also text a new customer.'),
          row('Walkthrough link', text('integrations.walkthroughUrl')),
          row('Map tiles', text('map.tileUrl'), 'OpenStreetMap by default. Keep the credit below if you change it.'),
          row('Map credit', text('map.attribution'))),
        card('Advanced',
          json('sale.checklist', 'Sale checklist', 'What a rep must tick before a sale saves. Keep the keys.'),
          json('sale.extraHolidays', 'Extra non-business days', 'Dates as "YYYY-MM-DD", e.g. Colorado holidays after legal review.'),
          json('goBacks.buckets', 'Times of day for go-backs'),
          row('Count a rep as "here now" for', num('coverage.hereNowMinutes', { unit: 'minutes after their last door', step: '5' })))),
      h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '10px' } },
        h('button', { type: 'button', class: 'btn btn--quiet', onclick: () => { invalidate('settings'); app.render(); } }, 'Discard changes'),
        h('button', { type: 'button', class: 'btn btn--primary', onclick: save }, 'Save settings')),
    ],
  };
}

const extraSections = [];
export function addSection(key, label, iconName, render) { extraSections.push([key, label, iconName, render]); }

export function install(appApi) {
  app = appApi;
  registerAdminSection('reps', 'Reps', 'user', repsSection);
  registerAdminSection('territory', 'Territory', 'map', territorySection);
  registerAdminSection('coverage', 'Coverage', 'chart', coverageSection);
  registerAdminSection('sales', 'Sales', 'dollar', salesSection);
  registerAdminSection('money', 'Money', 'cash', moneySection);
  registerAdminSection('scoreboard', 'Scoreboard', 'trophy', scoreboardSection);
  registerAdminSection('flags', 'Flags', 'flag', flagsSection);
  for (const extra of extraSections) registerAdminSection(...extra);
  registerAdminSection('settings', 'Settings', 'settings', settingsSection);
  app.registerScreen('admin', adminScreen, { admin: true, tab: { label: 'Admin', icon: 'shield', order: 90 } });
}

export { app as adminApp, load, money, percent, number, hoursLabel, dateLabel, timeLabel, downloadText, confirmSheet };
