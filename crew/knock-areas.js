/* Choose area: the rep's own neighborhoods and the open ones they may claim, nearest first by the
   phone's GPS (about how far, in miles). The rep's areas and "Work here" come from the phone's copy and
   work offline; claiming and releasing need signal, because the server keeps one rep per neighborhood
   (settings.territory: selfClaim, maxSelfClaims). An admin's assignment can only be removed by an admin. */
import { h, toast, badge, banner, emptyState, icon, loadingState, errorState, confirmSheet } from './knock-ui.js';
import { neighborhoodsByDistance } from './knock-doors.js';

let app;
// The last list from the server: { neighborhoods, hidden, selfClaim, at } (also kept in S.ui for offline).
let available = null;
let loading = null;
let loadError = null;
let busy = '';
const STALE_MS = 120000;

const S = () => app.S;

function cached() {
  return available || S().ui.areasCache || null;
}

async function loadAvailable({ force = false } = {}) {
  if (loading) return loading;
  if (!force && available && Date.now() - available.at < STALE_MS) return available;
  loading = (async () => {
    try {
      const data = await app.api('/api/knock-territory?view=available');
      available = { neighborhoods: data.neighborhoods || [], hidden: data.hidden || {}, selfClaim: data.selfClaim || null, at: Date.now() };
      loadError = null;
      // Only names, places and counts: safe to keep on the phone for an offline look.
      await app.saveUi({ areasCache: { ...available, neighborhoods: available.neighborhoods.filter(n => n.claim === 'open') } });
    } catch (error) {
      loadError = error;
      if (error.status === 0) S().online = false;
    } finally {
      loading = null;
    }
    if (S().route.name === 'areas') app.render();
    return available;
  })();
  return loading;
}

// Doors and sales on this phone that have not reached the server yet, in one neighborhood.
function unsentIn(neighborhoodId) {
  const inArea = event => event.houseId && S().houses.get(event.houseId)?.n === neighborhoodId;
  return [...S().pending, ...S().problems].filter(inArea).length;
}

async function workHere(n) {
  await app.saveUi({ workingNeighborhood: n.id, listNeighborhood: n.id, houseId: null, previousNumber: null });
  toast(`Working in ${n.name}`, { sub: 'The knock screen and the map suggest houses here first.', iconName: 'map' });
  app.render();
}

async function claim(n) {
  if (!S().online) return toast('Claiming needs signal', { tone: 'bad', sub: 'Your own areas still work offline. Try again with signal.' });
  busy = n.id;
  app.render();
  try {
    const result = await app.api('/api/knock-territory', { method: 'POST', body: { action: 'claim', neighborhoodId: n.id } });
    await app.saveUi({ workingNeighborhood: n.id, listNeighborhood: n.id, houseId: null, previousNumber: null });
    toast(result.already ? `${n.name} is already yours` : `${n.name} is yours`, { sub: 'Downloading its houses…', iconName: 'map' });
    available = null;
    busy = '';
    await app.sync({ full: true });
    // A sync already running skips this one; the next sync sees the new area and downloads it whole.
    if (!S().housesFor?.includes(n.id)) app.scheduleSync(1500);
    loadAvailable({ force: true });
  } catch (error) {
    busy = '';
    toast(error.status === 0 ? 'Claiming needs signal' : error.message, { tone: 'bad', sub: error.code === 'knock_claim_limit' ? 'Release an area you are done with first.' : '' });
    if (['knock_neighborhood_taken', 'knock_claim_conflict', 'knock_locked', 'knock_neighborhood_empty', 'knock_self_claim_off'].includes(error.code)) loadAvailable({ force: true });
    app.render();
  }
}

async function release(n) {
  if (!S().online) return toast('Releasing needs signal', { tone: 'bad', sub: 'Try again with signal.' });
  const unsent = unsentIn(n.id);
  // A door that has not synced would be refused once the area is released: sync it first.
  if (unsent) {
    app.scheduleSync(0);
    return toast(`${unsent} door${unsent === 1 ? '' : 's'} in ${n.name} ${unsent === 1 ? 'hasn\'t' : 'haven\'t'} synced`, { tone: 'bad', sub: 'Sync them (More > Sync) before releasing so nothing is lost.' });
  }
  const ok = await confirmSheet(`Release ${n.name}?`, 'Its houses leave this phone and another rep can claim it. Every door you logged there stays on record.', 'Release', 'danger');
  if (!ok) return;
  busy = n.id;
  app.render();
  try {
    await app.api('/api/knock-territory', { method: 'POST', body: { action: 'release', neighborhoodId: n.id } });
    if (S().ui.workingNeighborhood === n.id) await app.saveUi({ workingNeighborhood: null, houseId: null, previousNumber: null });
    toast(`Released ${n.name}`, { iconName: 'check' });
    busy = '';
    await app.sync({ full: true });
    if (S().housesFor?.includes(n.id)) app.scheduleSync(1500);
    loadAvailable({ force: true });
  } catch (error) {
    busy = '';
    toast(error.status === 0 ? 'Releasing needs signal' : error.message, { tone: 'bad' });
    app.render();
  }
}

function placeLine(n, extra = []) {
  return [app.awayLabel(n.meters) || (S().position ? 'location unknown' : ''), ...extra].filter(Boolean).join(' · ');
}

function myRow(n, working) {
  const houses = [...S().houses.values()].filter(house => house.n === n.id).length || n.importedCount || 0;
  const sub = n.locked ? placeLine(n, [n.lockReason]) : placeLine(n, [`${houses.toLocaleString('en-US')} houses`, n.streets ? `${n.streets.length} street${n.streets.length === 1 ? '' : 's'}` : '']);
  const busyHere = busy === n.id;
  return h('div', { class: `list-row list-row--card list-row--static area-row${n.id === working ? ' list-row--now' : ''}`, 'data-area': n.id },
    h('span', { class: 'list-row__main' },
      h('span', { class: 'list-row__title' }, n.name),
      h('span', { class: 'list-row__sub' }, sub),
      h('span', { class: 'area-row__badges' },
        n.id === working ? badge('Working', 'orange') : null,
        n.tier === 'Premium' ? badge('Premium', 'navy') : null,
        n.locked ? badge(n.status === 'hold' ? 'On hold' : 'Locked', 'warning', 'lock') : null,
        badge(n.source === 'self' ? 'You picked' : 'Assigned', n.source === 'self' ? 'info' : ''))),
    h('span', { class: 'area-row__actions' },
      !n.locked && n.id !== working ? h('button', { type: 'button', class: 'btn btn--primary btn--sm', onclick: () => workHere(n) }, 'Work here') : null,
      n.source === 'self' ? h('button', { type: 'button', class: 'btn btn--quiet btn--sm', disabled: busyHere, onclick: () => release(n) }, busyHere ? 'Releasing…' : 'Release') : null));
}

function openRow(n, rules) {
  const full = rules.used >= rules.max;
  const busyHere = busy === n.id;
  return h('div', { class: 'list-row list-row--card list-row--static area-row', 'data-area': n.id },
    h('span', { class: 'list-row__main' },
      h('span', { class: 'list-row__title' }, n.name),
      h('span', { class: 'list-row__sub' }, placeLine(n, [n.importedCount ? `${Number(n.importedCount).toLocaleString('en-US')} houses` : ''])),
      n.tier === 'Premium' ? h('span', { class: 'area-row__badges' }, badge('Premium', 'navy')) : null),
    h('span', { class: 'area-row__actions' },
      h('button', { type: 'button', class: 'btn btn--secondary btn--sm', disabled: busyHere || Boolean(busy) || full, 'aria-label': `Claim ${n.name}`, onclick: () => claim(n) }, busyHere ? 'Claiming…' : 'Claim')));
}

function hiddenLine(hidden = {}) {
  const parts = [
    hidden.taken ? `${hidden.taken} taken by other reps` : '',
    hidden.hold ? `${hidden.hold} on hold` : '',
    hidden.premium ? `${hidden.premium} need Premium clearance` : '',
    hidden.town ? `${hidden.town} in towns without knocking rules` : '',
    hidden.empty ? `${hidden.empty} with no houses loaded yet` : '',
  ].filter(Boolean);
  return parts.length ? h('p', { class: 'caption muted' }, `Not shown: ${parts.join(' · ')}.`) : null;
}

function areasScreen() {
  const online = S().online;
  if (online && !loading && (!available || Date.now() - available.at >= STALE_MS) && !loadError) queueMicrotask(() => loadAvailable());
  const working = S().ui.workingNeighborhood;
  const mine = app.myNeighborhoods();
  const list = cached();
  const mineIds = new Set(mine.map(n => n.id));
  const open = neighborhoodsByDistance(S().position, (list?.neighborhoods || []).filter(n => n.claim === 'open' && !mineIds.has(n.id)));
  const enabled = list?.selfClaim ? list.selfClaim.enabled : S().settings.territory?.selfClaim === true;
  const max = list?.selfClaim?.max || S().settings.territory?.maxSelfClaims || 2;
  const rules = { enabled, max, used: mine.filter(n => n.source === 'self').length };
  const refresh = h('button', { type: 'button', class: 'btn btn--quiet btn--sm', disabled: Boolean(loading) || !online, 'aria-label': 'Refresh nearby areas',
    onclick: () => { loadError = null; loadAvailable({ force: true }); app.render(); } }, icon('refresh'), 'Refresh');
  let nearby;
  if (!enabled) nearby = emptyState('lock', 'Your lead assigns neighborhoods', 'Picking your own area is turned off. Ask your lead for a neighborhood; it shows up above once it\'s assigned.');
  else if (!list && loading) nearby = loadingState(3);
  else if (!list && loadError) nearby = errorState(loadError, () => { loadError = null; loadAvailable({ force: true }); app.render(); });
  else if (!list && !online) nearby = emptyState('wifiOff', 'Nearby areas need signal', 'Connect once to see the open neighborhoods near you.');
  else if (!open.length) nearby = emptyState('map', 'No open neighborhoods right now', 'Every neighborhood is taken, on hold or locked. Ask your lead which one to work.');
  else nearby = h('div', { class: 'stack stack--tight' }, open.map(n => openRow(n, rules)));
  return h('div', { class: 'screen' },
    app.locationBanner(),
    !online ? banner('warn', 'wifiOff', 'No signal', 'Claiming or releasing an area needs signal. Your own areas below still work offline.') : null,
    loadError && list && loadError.status !== 0 ? errorState(loadError, () => { loadError = null; loadAvailable({ force: true }); app.render(); }) : null,
    h('section', { class: 'stack', 'aria-labelledby': 'areas-mine' },
      h('div', { class: 'row row--between' }, h('h2', { id: 'areas-mine', style: { fontSize: '18px' } }, 'My areas'),
        enabled ? h('span', { class: 'caption muted' }, `${rules.used} of ${rules.max} picked`) : null),
      mine.length ? h('div', { class: 'stack stack--tight' }, mine.map(n => myRow(n, working)))
        : h('p', { class: 'muted' }, enabled ? 'Nothing yet. Claim an open neighborhood below to start knocking.' : 'Nothing assigned yet.')),
    h('section', { class: 'stack', 'aria-labelledby': 'areas-near' },
      h('div', { class: 'row row--between' }, h('h2', { id: 'areas-near', style: { fontSize: '18px' } }, S().position ? 'Nearby areas' : 'Open areas'), enabled ? refresh : null),
      enabled && rules.used >= rules.max ? banner('info', 'info', `You hold ${rules.max} of ${rules.max}`, 'Release an area you are done with to claim another.') : null,
      enabled && !S().position ? h('p', { class: 'caption muted' }, 'Turn on location to sort these by distance.') : null,
      nearby,
      enabled && list ? hiddenLine(list.hidden) : null,
      list?.at && !available ? h('p', { class: 'caption muted' }, `Saved list from ${new Date(list.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`) : null));
}

export function install(appApi) {
  app = appApi;
  app.registerScreen('areas', areasScreen, { title: 'Choose area', back: 'home' });
  app.moreLinks.push({ route: 'areas', label: 'Choose area', icon: 'map', order: 5,
    hint: () => (S().settings.territory?.selfClaim ? 'Your neighborhoods and open ones near you' : 'Your neighborhoods, nearest first') });
}

export { loadAvailable };
