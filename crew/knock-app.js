/* EGC Knock: door-to-door canvassing for reps, leads and admins.
   Opens from the phone's own copy (IndexedDB) first so a rep can log doors with no signal, then
   refreshes from /api/knock-*. Every change is an append-only event in the outbox. */
import { h, mount, toast, uuid, icon, badge, banner, kv, emptyState, sheet } from './knock-ui.js';
import { createOutbox, httpTransport, openKnockStore } from './knock-outbox.js';
import { DEFAULT_SETTINGS, mergeSettings } from './knock-settings.js';
import { formatClock, knockWindow } from './knock-time.js';
import { applyLocalKnock, doorStatus, milesLabel, neighborhoodsByDistance, territoryState } from './knock-doors.js';
import { shiftTiming } from './knock-stats.js';

const VIEWER_KEY = 'egc-knock:viewer';
const SIGNED_OUT_KEY = 'egc-knock:signed-out-at';
const THEME_KEY = 'egc-knock:theme';
const SESSION_HOURS = 12;

const main = document.getElementById('knock-main');
const tabs = document.getElementById('knock-tabs');
const top = document.getElementById('knock-top');
const clock = document.getElementById('knock-clock');
const syncPill = document.getElementById('knock-sync');
syncPill.addEventListener('click', () => go('more'));

const S = {
  online: navigator.onLine,
  viewer: null,
  rep: null,
  settings: mergeSettings({}),
  eligibility: { ok: false, reason: '' },
  territory: { neighborhoods: [] },
  houses: new Map(),
  housesSyncedAt: '',
  // The unlocked neighborhoods the cached houses cover; a new or reopened one needs a full download.
  housesFor: null,
  shift: null,
  pending: [],
  problems: [],
  position: null,
  // Why there is no GPS fix: null, or { code: 'denied' | 'unavailable' | 'timeout' | 'unsupported' }.
  positionError: null,
  lastSync: null,
  syncState: 'idle',
  authRequired: false,
  loaded: false,
  route: { name: 'home', params: new URLSearchParams() },
  ui: {},
};

let store;
let outbox;
const screens = new Map();
const modules = {};

/* ---------- small utilities ---------- */

function remember(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
function recall(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } }
function forget(key) { try { localStorage.removeItem(key); } catch {} }

async function api(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw Object.assign(new Error('No connection. Try again when you have signal.'), { status: 0 });
  }
  const type = response.headers.get('Content-Type') || '';
  if (type.includes('text/csv')) {
    if (!response.ok) throw Object.assign(new Error(`Export failed (${response.status})`), { status: response.status });
    return { csv: await response.text(), filename: /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '')?.[1] || 'export.csv' };
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    if (response.status === 401) onAuthRequired();
    throw Object.assign(new Error(data.error || `Request failed (${response.status})`), { status: response.status, code: data.code || '', details: data.details });
  }
  return data;
}

function applyTheme(theme = recall(THEME_KEY) || 'auto') {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

/* ---------- house state: server summary plus this phone's unsent events ---------- */

const userKey = () => S.viewer?.user || '';
const cacheKey = name => `${name}:${userKey().toLowerCase()}`;

function foldPending(houseId, summary) {
  let current = summary;
  for (const event of S.pending) {
    if (event.houseId !== houseId || event.state === 'error') continue;
    if (event.type === 'knock') current = applyLocalKnock(current, { ...event, repId: S.viewer?.repKey }, { seasonStart: S.settings.goBacks.seasonStart, now: Date.now() });
    else if ((event.type === 'knock.void' || event.type === 'knock.edit') && event._prev !== undefined) {
      // _prev is this house's summary from before the knock being undone or edited.
      current = event._prev;
      if (event.type === 'knock.edit') {
        const edited = { ...event._knock, outcome: event.outcome, carOutside: event.carOutside, quotedAmount: event.quotedAmount, comeBackAt: event.comeBackAt, id: event.target, repId: S.viewer?.repKey };
        current = applyLocalKnock(current, edited, { seasonStart: S.settings.goBacks.seasonStart, now: Date.now() });
      }
    }
  }
  return current;
}

export function houseView(id) {
  const house = S.houses.get(id);
  if (!house) return null;
  const summary = foldPending(id, house.summary || null);
  const status = doorStatus(house, summary, { ...S.settings, timeZone: cityRuleFor(house)?.timeZone }, Date.now());
  return { house, summary, status };
}

export function neighborhoodOf(house) {
  return S.territory.neighborhoods.find(n => n.id === (house?.n || house?.neighborhoodId)) || null;
}

export function cityRuleFor(house) {
  const nbhd = house ? neighborhoodOf(house) : S.territory.neighborhoods.find(n => !n.locked);
  return S.settings.cities[nbhd?.cityKey || 'fort-collins'] || S.settings.cities['fort-collins'] || DEFAULT_SETTINGS.cities['fort-collins'];
}

/* ---------- shift state: server shift plus unsent shift events ---------- */

export function currentShift() {
  let shift = S.shift ? structuredClone(S.shift) : null;
  for (const event of S.pending) {
    if (event.state === 'error') continue;
    if (event.type === 'shift.start') shift = { id: event.shiftId, startedAt: event.at, endedAt: null, breaks: [], doors: 0, lastDoorAt: null, cityKey: event.cityKey, local: true };
    if (!shift || event.shiftId !== shift.id) continue;
    if (event.type === 'shift.break_start') shift.breaks = [...(shift.breaks || []), { id: event.id, startAt: event.at, endAt: null }];
    if (event.type === 'shift.break_end') {
      const open = [...(shift.breaks || [])].reverse().find(b => !b.endAt);
      if (open) open.endAt = event.at;
    }
    if (event.type === 'shift.end') shift.endedAt = event.at;
    if (event.type === 'knock') { shift.doors = (shift.doors || 0) + (event.outcome === 'skipped_sign' ? 0 : 1); shift.lastDoorAt = event.at; }
  }
  if (!shift || shift.endedAt) return null;
  const timing = shiftTiming(shift, Date.now(), S.settings.shift.idleAutoEndHours);
  if (!timing || timing.ended) return null;
  return { ...shift, timing };
}

/* ---------- events ---------- */

export async function enqueue(type, fields) {
  if (!S.viewer) throw new Error('Sign in first.');
  const event = { id: uuid(), user: S.viewer.user, type, at: new Date().toISOString(), ...fields };
  await outbox.enqueue(event);
  await refreshPending();
  scheduleSync(1200);
  return event;
}

async function refreshPending() {
  const rows = await outbox.list(userKey());
  S.pending = rows.filter(e => e.state === 'queued');
  S.problems = rows.filter(e => e.state === 'error');
  renderChrome();
}

/* ---------- sync ---------- */

let syncTimer = 0;
export function scheduleSync(delay = 0) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { sync().catch(() => {}); }, delay);
}

async function onSynced(response) {
  if (Array.isArray(response?.houses)) {
    for (const house of response.houses) S.houses.set(house.id, house);
    await store.cache.set(cacheKey('houses'), [...S.houses.values()]);
  }
  if (response && 'shift' in response) {
    S.shift = response.shift;
    await saveMe();
  }
}

export async function sync({ full = false } = {}) {
  if (!S.viewer || S.syncState === 'syncing') return;
  S.syncState = 'syncing';
  renderChrome();
  try {
    const result = await outbox.flush({ user: S.viewer.user, onApplied: onSynced });
    await refreshPending();
    if (result.stopped?.reason === 'auth') { S.syncState = 'auth'; onAuthRequired(); return; }
    if (result.stopped?.reason === 'network') { S.online = false; S.syncState = 'offline'; return; }
    if (result.stopped) { S.syncState = 'retry'; scheduleSync(30000); return; }
    S.online = true;
    if (full || !S.loaded) await loadServer();
    else await loadHouses();
    S.lastSync = Date.now();
    S.syncState = 'idle';
  } catch {
    S.syncState = S.online ? 'retry' : 'offline';
  } finally {
    if (S.syncState === 'syncing') S.syncState = 'idle';
    renderChrome();
    render();
  }
}

/* ---------- location: one GPS watch for the whole app while an approved rep has it open ---------- */

let watchId = null;
// After a refusal the watch restarts only when the rep asks (Try again) or comes back to the app, so a
// phone set to ask every time is not prompted on every screen.
let refused = false;
const positionListeners = [];
// Screens that show the rep's position or a location banner re-render when location starts or fails.
const LOCATION_SCREENS = new Set(['home', 'map', 'areas', 'knock', 'list']);

export function onPosition(listener) { positionListeners.push(listener); }

function locationChanged() {
  if (LOCATION_SCREENS.has(S.route.name) && S.rep?.status === 'active') render();
}

export function startLocation({ retry = false } = {}) {
  if (retry) refused = false;
  if (watchId != null || refused || S.rep?.status !== 'active' || document.visibilityState === 'hidden') return;
  if (!navigator.geolocation) {
    if (!S.positionError) { S.positionError = { code: 'unsupported' }; locationChanged(); }
    return;
  }
  watchId = navigator.geolocation.watchPosition(position => {
    const first = !S.position, recovered = Boolean(S.positionError);
    S.position = { lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy, at: Date.now() };
    S.positionError = null;
    for (const listener of positionListeners) { try { listener(S.position, { first }); } catch { /* One screen's listener never stops the others. */ } }
    if (first || recovered) locationChanged();
  }, error => {
    const code = error?.code === 1 ? 'denied' : error?.code === 2 ? 'unavailable' : 'timeout';
    const changed = S.positionError?.code !== code;
    S.positionError = { code };
    // A refusal stands until the rep allows it (Try again, or coming back to the app); a weak signal keeps trying.
    if (code === 'denied') { refused = true; stopLocation(); }
    if (changed) locationChanged();
  }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 });
}

export function stopLocation() {
  if (watchId != null) navigator.geolocation?.clearWatch(watchId);
  watchId = null;
}

// Why the phone has no location yet, with the fix. Null while location works (or is still starting).
export function locationBanner() {
  const code = S.position && Date.now() - S.position.at < 120000 ? '' : S.positionError?.code;
  const retry = h('button', { type: 'button', class: 'btn btn--sm btn--secondary', onclick: () => { S.positionError = null; stopLocation(); startLocation({ retry: true }); render(); } }, 'Try again');
  if (code === 'denied') return banner('warn', 'crosshair', 'Location is off for EGC Knock', 'Allow location for this site in your browser or phone settings so the map shows where you are and which houses and neighborhoods are closest. Doors still log without it.', retry);
  if (code === 'unsupported') return banner('warn', 'crosshair', 'This browser can\'t share your location', 'Open EGC Knock in Safari or Chrome to see where you are on the map.');
  if (code === 'unavailable' || code === 'timeout') return banner('info', 'crosshair', 'Looking for your location…', 'Your phone can\'t find you right now. Step outside or wait a moment. Doors still log without it.', retry);
  return null;
}

/* ---------- loading ---------- */

async function saveMe() {
  await store.cache.set(cacheKey('me'), { rep: S.rep, settings: S.settings, eligibility: S.eligibility, territory: S.territory, shift: S.shift, viewer: S.viewer, savedAt: Date.now() });
}

async function loadServer() {
  const me = await api('/api/knock-me');
  S.viewer = { ...S.viewer, ...me.viewer };
  S.rep = me.rep;
  S.settings = mergeSettings(me.settings);
  S.eligibility = me.eligibility;
  S.territory = me.territory || { neighborhoods: [] };
  if ('shift' in me) S.shift = me.shift;
  remember(VIEWER_KEY, { ...S.viewer, savedAt: Date.now() });
  await saveMe();
  if (S.rep?.status === 'active') await loadHouses({ full: !S.housesSyncedAt });
  S.loaded = true;
}

async function loadHouses({ full = false } = {}) {
  if (S.rep?.status !== 'active') return;
  const since = full ? '' : S.housesSyncedAt;
  const data = await api(`/api/knock-territory${since ? `?since=${encodeURIComponent(since)}` : ''}`);
  const allowed = new Set((data.neighborhoods || []).filter(n => !n.locked).map(n => n.id));
  // A delta carries only changed houses: a neighborhood claimed, assigned or reopened since the last
  // download needs every house, so fetch the whole territory once.
  if (!full && !data.full && [...allowed].some(id => !S.housesFor?.includes(id))) return loadHouses({ full: true });
  if (full || data.full) S.houses = new Map();
  for (const house of data.houses || []) S.houses.set(house.id, house);
  // Drop houses from territory that is no longer assigned or is now locked.
  for (const [id, house] of S.houses) if (!allowed.has(house.n)) S.houses.delete(id);
  if (data.neighborhoods) S.territory = { neighborhoods: data.neighborhoods };
  S.housesSyncedAt = data.serverTime || '';
  S.housesFor = [...allowed];
  await store.cache.set(cacheKey('houses'), [...S.houses.values()]);
  await store.cache.set(cacheKey('housesSyncedAt'), S.housesSyncedAt);
  await store.cache.set(cacheKey('housesFor'), S.housesFor);
  await saveMe();
}

async function restoreCache() {
  const me = await store.cache.get(cacheKey('me'));
  if (me) {
    S.rep = me.rep; S.settings = mergeSettings(me.settings); S.eligibility = me.eligibility || S.eligibility;
    S.territory = me.territory || S.territory; S.shift = me.shift || null;
  }
  const houses = await store.cache.get(cacheKey('houses'));
  if (Array.isArray(houses)) S.houses = new Map(houses.map(h => [h.id, h]));
  S.housesSyncedAt = (await store.cache.get(cacheKey('housesSyncedAt'))) || '';
  const covered = await store.cache.get(cacheKey('housesFor'));
  S.housesFor = Array.isArray(covered) ? covered : null;
  S.ui = (await store.cache.get(cacheKey('ui'))) || {};
  await refreshPending();
  return Boolean(me);
}

export async function saveUi(patch) {
  S.ui = { ...S.ui, ...patch };
  await store.cache.set(cacheKey('ui'), S.ui);
}

/* ---------- auth ---------- */

function onAuthRequired() {
  S.authRequired = true;
  renderChrome();
}

function offlineViewer() {
  const viewer = recall(VIEWER_KEY);
  const signedOutAt = Number(recall(SIGNED_OUT_KEY) || 0);
  if (!viewer?.user || viewer.savedAt <= signedOutAt) return null;
  if (Date.now() - viewer.savedAt > SESSION_HOURS * 3600000) return null;
  return viewer;
}

async function signIn(username, password) {
  const data = await api('/api/hub-auth', { method: 'POST', body: { username, password } });
  S.viewer = { user: data.user, displayName: data.displayName || data.user };
  S.authRequired = false;
  remember(VIEWER_KEY, { ...S.viewer, savedAt: Date.now() });
  await restoreCache();
  await loadServer();
  scheduleSync(0);
  go(S.route.name === 'signin' ? 'home' : S.route.name);
}

export async function signOut() {
  try { await api('/api/hub-auth', { method: 'DELETE' }); } catch {}
  remember(SIGNED_OUT_KEY, Date.now());
  forget(VIEWER_KEY);
  S.viewer = null; S.rep = null; S.houses = new Map(); S.pending = []; S.shift = null; S.loaded = false;
  stopLocation(); refused = false; S.position = null; S.positionError = null;
  renderSignIn();
}

function renderSignIn(error = '') {
  tabs.hidden = true; clock.hidden = true; top.hidden = true;
  document.body.classList.remove('admin-mode');
  const password = h('input', { class: 'input', id: 'password', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const reveal = h('button', { type: 'button', class: 'ico-btn', 'aria-label': 'Show password', onclick: () => {
    const show = password.type === 'password';
    password.type = show ? 'text' : 'password';
    reveal.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  } }, icon('eye'));
  const form = h('form', { class: 'screen signin', onsubmit: async event => {
    event.preventDefault();
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try { await signIn(form.username.value.trim(), form.password.value); }
    catch (err) { renderSignIn(err.status === 401 ? 'That username or password didn\'t work.' : err.message); }
    finally { button.disabled = false; }
  } },
  h('h1', {}, 'Sign in'),
  error ? banner('error', 'alert', error, error.startsWith('That username') ? 'Check your caps lock and try again.' : '') : null,
  h('div', { class: 'field' }, h('label', { class: 'label', for: 'username' }, 'Username'),
    h('input', { class: 'input', id: 'username', name: 'username', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true })),
  h('div', { class: 'field' }, h('label', { class: 'label', for: 'password' }, 'Password'), h('div', { class: 'password-field' }, password, reveal)),
  h('button', { type: 'submit', class: 'btn btn--primary btn--xl btn--block' }, 'Sign in'),
  h('p', { class: 'muted center' }, 'Use your EGC Hub sign-in. Can\'t sign in? Ask your lead or text the office.'),
  h('div', { class: 'spacer' }),
  banner('', 'wifiOff', 'Works offline', 'Once you\'ve signed in on this phone, you can keep knocking without signal.'));
  mount(main,
    h('div', { class: 'signin-hero' }, h('div', { class: 'wordmark' }, 'EGC ', h('em', {}, 'Knock')), h('p', {}, 'Easy Garage Cleaning · Fort Collins')),
    form);
}

/* ---------- routing and rendering ---------- */

// tab: { label, icon, order } puts the screen in the tab bar; title and back give it a titled top bar
// with a back arrow (back is a route, or a function of the route params).
export function registerScreen(name, render, { tab = null, admin = false, active = true, title = '', back = '' } = {}) {
  screens.set(name, { render, tab, admin, active, title, back });
}

export function go(name, params = {}) {
  const query = new URLSearchParams(params).toString();
  const hash = `#${name}${query ? `?${query}` : ''}`;
  if (location.hash !== hash) location.hash = hash;
  else route();
}

function parseRoute() {
  const raw = location.hash.replace(/^#/, '') || 'home';
  const [name, query = ''] = raw.split('?');
  return { name, params: new URLSearchParams(query) };
}

let adminLoading = null;
function ensureAdmin() {
  if (modules.admin || !S.viewer?.admin) return Promise.resolve();
  adminLoading ||= import('./knock-admin.js')
    .then(module => { modules.admin = module; module.install(app); })
    .catch(() => { adminLoading = null; toast('The admin screens need a connection the first time.', { tone: 'bad' }); });
  return adminLoading;
}

async function route() {
  S.route = parseRoute();
  if (S.route.name.startsWith('admin')) await ensureAdmin();
  render();
}

let autoRouted = false;
export function render() {
  if (!S.viewer) return renderSignIn();
  // Pocket to door: with a shift running, opening the app lands on the knock screen.
  if (!autoRouted && !location.hash && S.rep?.status === 'active' && screens.has('knock')) {
    autoRouted = true;
    if (currentShift()) { location.hash = '#knock'; return; }
  }
  const screen = screens.get(S.route.name) || screens.get('home');
  document.body.classList.toggle('admin-mode', Boolean(S.rep?.status === 'active' && screen.admin));
  renderChrome();
  if (!S.rep) { mount(main, h('div', { class: 'screen' }, h('p', { class: 'muted', role: 'status' }, S.online ? 'Loading your canvassing profile…' : 'Connect once to load your canvassing profile.'))); return; }
  if (S.rep.status !== 'active') return renderWaiting();
  if (screen.admin && !S.viewer.admin) return mount(main, h('div', { class: 'screen' }, banner('error', 'lock', 'Only admins can open that screen.')));
  if (screen.admin && !modules.admin) ensureAdmin().then(() => { if (modules.admin) render(); });
  // Location starts with the rep's first screen (not only Knock), so Home, Map and the lists know where they are.
  if (!screen.admin) startLocation();
  try {
    mount(main, screen.render(app, S.route.params));
  } catch (error) {
    mount(main, h('div', { class: 'screen' }, banner('error', 'alert', 'Something went wrong', error.message || String(error),
      h('button', { type: 'button', class: 'btn btn--sm btn--retry', onclick: () => location.reload() }, 'Reload'))));
  }
  renderTabs();
}

function renderWaiting() {
  tabs.hidden = true;
  const inactive = S.rep.status === 'inactive';
  mount(main, h('div', { class: 'screen' },
    h('h1', {}, inactive ? 'Access turned off' : `Thanks, ${firstName()}`),
    emptyState(inactive ? 'lock' : 'clock', inactive ? 'Canvassing is turned off for you' : 'Waiting for approval',
      inactive ? 'Your canvassing access was turned off. Talk to Zac if this is a mistake.' : 'An admin approves new reps before territory shows up. Nothing is lost while you wait.',
      h('button', { type: 'button', class: 'btn btn--primary', onclick: () => sync({ full: true }) }, icon('refresh'), 'Check again')),
    h('button', { type: 'button', class: 'btn btn--quiet btn--block', onclick: signOut }, 'Sign out')));
}

const TAB_ICONS = { home: 'home', knock: 'door', list: 'list', map: 'map', more: 'more', admin: 'shield' };

function renderTabs() {
  const items = [...screens.entries()].filter(([, s]) => s.tab && (!s.admin || S.viewer?.admin)).sort((a, b) => (a[1].tab.order ?? 50) - (b[1].tab.order ?? 50));
  tabs.hidden = !items.length;
  const current = screens.get(S.route.name);
  // A screen without its own tab (Go-backs, My money…) lights the More tab; admin screens light Admin.
  const activeTab = current?.tab ? S.route.name : current?.admin ? 'admin' : S.route.name === 'home' || !current ? 'home' : 'more';
  mount(tabs, items.map(([name, s]) => h('a', { class: `tab${name === activeTab ? ' tab--active' : ''}`, href: `#${name}`, 'aria-current': name === activeTab ? 'page' : false },
    icon(s.tab.icon || TAB_ICONS[name] || 'more'), s.tab.label)));
}

export function knockingWindow(house = null) {
  return knockWindow(cityRuleFor(house), Date.now());
}

// "2:14" for hours and minutes, "14 min" inside the last hour.
function leftLabel(ms) {
  const minutes = Math.max(0, Math.ceil(ms / 60000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

function renderChrome() {
  if (!S.viewer) return;
  const screen = screens.get(S.route.name);
  top.hidden = false;
  // A titled screen gets a back arrow and its name; the rest show the wordmark.
  const back = screen?.title ? (typeof screen.back === 'function' ? screen.back(S.route.params) : screen.back) : '';
  if (screen?.title && S.rep?.status === 'active') {
    mount(top,
      h('button', { type: 'button', class: 'ico-btn', 'aria-label': 'Back', onclick: () => (back ? go(back) : history.back()) }, icon('arrowLeft')),
      h('span', { class: 'serif grow', style: { fontSize: '22px' } }, typeof screen.title === 'function' ? screen.title(S.route.params) : screen.title),
      syncPill);
  } else if (!top.querySelector('.wordmark')) {
    mount(top, h('a', { class: 'wordmark', href: '/crew/knock.html#home' }, 'EGC ', h('em', {}, 'Knock')), syncPill);
  }

  const window = knockingWindow(S.ui.houseId ? S.houses.get(S.ui.houseId) : null);
  clock.hidden = false;
  const late = window.phase === 'grace' || window.phase === 'closed';
  clock.className = `sunbar${window.warning ? ' sunbar--warn' : ''}${late ? ' sunbar--late' : ''}`;
  mount(clock, icon('sun', { size: 'sm' }),
    window.phase === 'before' ? `Knocking opens ${window.startLabel} · sunset ${window.endLabel}`
      : window.phase === 'open' ? `Sunset ${window.endLabel} · ${leftLabel(window.msToEnd)} left`
      : window.phase === 'grace' ? `Sun set ${window.endLabel} · this door only`
      : `Sunset was ${window.endLabel} · closed for today`);

  syncPill.hidden = false;
  const { state, label } = syncSummary();
  syncPill.className = `sync sync--${state}`;
  syncPill.setAttribute('aria-label', `${label}. Opens the sync section.`);
  mount(syncPill, h('span', { class: 'sync__dot' }), label);
  document.querySelectorAll('[data-sync-pill]').forEach(pill => {
    pill.className = `sync sync--${state}`;
    mount(pill, h('span', { class: 'sync__dot' }), label);
  });
}

// The sync pill is the single source of truth: Synced, N waiting, Offline or Sync problem.
export function syncSummary() {
  const pending = S.pending.length, problems = S.problems.length;
  const state = problems || S.authRequired ? 'problem' : !S.online ? 'offline' : pending || S.syncState === 'syncing' ? 'waiting' : 'ok';
  // Offline with doors queued shows the count (gray dot), so a rep always knows what is waiting.
  const label = problems ? 'Sync problem' : S.authRequired ? 'Sign in to sync' : S.syncState === 'syncing' && S.online ? 'Syncing…' : pending ? `${pending} waiting` : !S.online ? 'Offline' : 'Synced';
  return { state, label };
}

const firstName = () => String(S.rep?.displayName || S.viewer?.displayName || '').trim().split(/\s+/)[0] || 'there';

/* ---------- territory: distances and why it is empty ---------- */

// "0.4 mi away" from the phone's GPS, "you're here" inside a tenth of a mile.
export function awayLabel(meters) {
  const miles = milesLabel(meters);
  return !miles ? '' : miles === 'here' ? 'you\'re here' : `${miles} away`;
}

// The rep's neighborhoods nearest first (name order without GPS), unlocked before locked.
export function myNeighborhoods() {
  const rows = neighborhoodsByDistance(S.position, S.territory.neighborhoods, { houses: S.houses.values() });
  return [...rows.filter(n => !n.locked), ...rows.filter(n => n.locked)];
}

/* Why there is nothing to knock or map, with the one action that fixes it; null once houses with a
   location are on this phone. Not approved, nothing claimed or assigned, all locked, none imported,
   not downloaded yet, or houses without a location. */
export function territoryEmpty() {
  const state = territoryState({ rep: S.rep, neighborhoods: S.territory.neighborhoods, houses: S.houses.values() });
  const selfClaim = S.settings.territory?.selfClaim === true;
  const choose = (label = 'Choose an area') => h('a', { class: 'btn btn--primary', href: '#areas' }, icon('map'), label);
  const check = label => h('button', { type: 'button', class: 'btn btn--primary', onclick: () => sync({ full: true }) }, icon('refresh'), label);
  const count = S.territory.neighborhoods.length;
  if (state === 'ok') return null;
  if (state === 'pending') return emptyState('clock', 'Waiting for approval', 'An admin approves new reps before any territory shows up. Nothing is lost while you wait.', check('Check again'));
  if (state === 'inactive') return emptyState('lock', 'Canvassing is turned off for you', 'Your canvassing access was turned off. Talk to Zac if this is a mistake.');
  if (state === 'none') {
    return selfClaim
      ? emptyState('map', 'No neighborhood yet', 'Pick an open neighborhood near you to start knocking. Its houses download to this phone.', choose())
      : emptyState('map', 'Nothing assigned yet', 'Ask your lead for a neighborhood. It shows up here once it\'s assigned.', check('Check again'));
  }
  if (state === 'locked') {
    return emptyState('lock', count === 1 ? 'Your neighborhood is locked' : 'Your neighborhoods are locked',
      `${S.territory.neighborhoods.map(n => `${n.name}: ${n.lockReason || 'locked'}`).join(' · ')}. Nothing there can be knocked until an admin opens it.`,
      selfClaim ? choose('Choose another area') : check('Check again'));
  }
  if (state === 'empty') {
    return emptyState('home', 'No houses loaded yet', 'Your neighborhood has no houses imported yet. Ask Zac to run the house import.', selfClaim ? choose('Choose another area') : check('Check again'));
  }
  if (state === 'not_loaded') {
    return emptyState('refresh', 'Houses haven\'t downloaded yet', S.online ? 'Your neighborhood is ready. Sync to download its houses to this phone.' : 'Connect once to download your neighborhood\'s houses. After that they work offline.', check('Sync now'));
  }
  return emptyState('map', 'These houses have no map location', 'The list still works. Tell Zac so the houses can be imported again with their locations.', h('a', { class: 'btn btn--primary', href: '#list' }, 'Open the list'));
}

/* ---------- home ---------- */

function homeScreen() {
  const nbhds = myNeighborhoods();
  const working = S.ui.workingNeighborhood;
  const window = knockingWindow();
  const today = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: cityRuleFor(null)?.timeZone || 'America/Denver' });
  const counts = new Map();
  for (const house of S.houses.values()) {
    const row = counts.get(house.n) || { total: 0, knocked: 0 };
    row.total += 1;
    if (houseView(house.id)?.summary?.lastOutcome) row.knocked += 1;
    counts.set(house.n, row);
  }
  const permit = S.rep.permitListed !== false;
  return h('div', { class: 'screen' },
    S.authRequired ? banner('warn', 'alert', 'Your sign-in expired', 'Your doors are safe on this phone. Sign in to sync them.',
      h('button', { type: 'button', class: 'btn btn--sm btn--primary', onclick: () => renderSignIn() }, 'Sign in')) : null,
    h('div', { class: 'row row--between' }, h('h1', {}, `Hi ${firstName()}`), h('span', { class: 'muted' }, today)),
    h('section', { class: 'card', style: { gap: '8px' } },
      h('h2', {}, 'Today\'s status'),
      kv('Account', badge('Approved', 'success', 'check')),
      kv('City permit list', permit ? badge('On the list', 'success', 'check') : badge('Not on the list', 'warning', 'alert')),
      kv('Knocking window', `${window.startLabel} – ${window.endLabel}`)),
    S.eligibility.ok ? null : banner('warn', 'alert', 'You can\'t start a shift yet', S.eligibility.reason),
    locationBanner(),
    app.shiftCard ? app.shiftCard() : null,
    h('section', { class: 'stack' },
      h('div', { class: 'row row--between' }, h('h2', { style: { fontSize: '18px' } }, 'Your neighborhoods'),
        screens.has('areas') ? h('a', { class: 'btn btn--quiet btn--sm', href: '#areas' }, icon('map'), 'Choose area') : h('span', { class: 'caption muted' }, `${nbhds.length} assigned`)),
      nbhds.map(n => {
        const count = counts.get(n.id) || { total: n.importedCount || 0, knocked: 0 };
        const away = awayLabel(n.meters);
        const sub = n.locked ? n.lockReason : `${(count.total || n.importedCount || 0).toLocaleString('en-US')} houses · ${count.knocked} knocked${n.streets ? ` · ${n.streets.length} street${n.streets.length === 1 ? '' : 's'}` : ''}${away ? ` · ${away}` : ''}`;
        const tier = n.tier === 'Premium' ? badge('Premium', 'navy') : badge(n.tier || 'Volume');
        if (n.locked) {
          return h('div', { class: 'list-row list-row--card list-row--static', style: { opacity: '.85' } },
            h('span', { class: 'list-row__main' }, h('span', { class: 'list-row__title' }, n.name), h('span', { class: 'list-row__sub' }, sub)),
            badge(n.status === 'hold' ? 'On hold' : 'Locked', 'warning', 'lock'));
        }
        return h('a', { class: `list-row list-row--card${n.id === working ? ' list-row--now' : ''}`, href: `#list?n=${encodeURIComponent(n.id)}` },
          h('span', { class: 'list-row__main' }, h('span', { class: 'list-row__title' }, n.name), h('span', { class: 'list-row__sub' }, sub)),
          n.id === working ? badge('Working', 'orange') : tier, icon('chevronRight'));
      }),
      territoryEmpty()));
}

/* ---------- more: profile, links, sync and the phone's settings ---------- */

function initials(name) {
  return String(name || '').trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || '?';
}

const EVENT_NAMES = { knock: 'Door', sale: 'Sale', 'knock.void': 'Undo', 'knock.edit': 'Change', 'shift.start': 'Shift start', 'shift.end': 'Shift end', 'shift.break_start': 'Break', 'shift.break_end': 'Break end' };

function problemTitle(event) {
  const house = event.houseId ? S.houses.get(event.houseId) : null;
  const where = house ? `${house.number} ${house.street.split(' ').map(w => w.charAt(0) + w.slice(1).toLowerCase()).join(' ')}` : '';
  const extra = event.type === 'sale' ? [event.customer?.name?.split(' ').slice(-1)[0], event.ticket ? `$${Number(event.ticket).toLocaleString('en-US')}` : ''] : [];
  return [EVENT_NAMES[event.type] || event.type, where, ...extra].filter(Boolean).join(' · ');
}

function syncCard() {
  const pending = S.pending.length, problems = S.problems;
  const state = problems.length ? badge(`${problems.length} need a look`, 'error') : !S.online ? badge('Offline') : pending ? badge(`${pending} waiting`, 'warning') : badge('Synced', 'success', 'check');
  return h('section', { class: 'card', id: 'sync' },
    h('div', { class: 'row row--between' }, h('h2', {}, 'Sync'), state),
    pending ? h('p', {}, h('b', {}, `${pending} change${pending === 1 ? '' : 's'} saved on this phone.`), ' They\'ll sync when you have signal. You can keep knocking.')
      : h('p', {}, 'Everything on this phone is synced.'),
    store?.persistent === false ? banner('error', 'alert', 'This browser isn\'t saving offline data', 'Keep signal, or add EGC Knock to your home screen.') : null,
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'btn btn--secondary grow', onclick: () => sync({ full: true }) }, icon('refresh'), 'Sync now'),
      h('span', { class: 'caption muted', style: { textAlign: 'right' } }, 'Last synced', h('br', {}), S.lastSync ? new Date(S.lastSync).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase() : 'not yet')),
    problems.length ? h('div', { class: 'stack stack--tight' },
      h('span', { class: 'bold', style: { color: 'var(--error)' } }, `${problems.length} need${problems.length === 1 ? 's' : ''} a look`),
      problems.map(event => banner('error', 'alert', problemTitle(event), `${event.error?.message || 'The server refused this change.'} Nothing else was lost.`,
        h('div', { class: 'stack stack--tight', style: { alignItems: 'flex-end' } },
          h('button', { type: 'button', class: 'btn btn--sm btn--retry', onclick: async () => { await outbox.retry(event.id); await refreshPending(); scheduleSync(0); } }, 'Retry'),
          h('button', { type: 'button', class: 'link caption', onclick: async () => { await outbox.remove(event.id); await refreshPending(); render(); } }, 'Discard'))))) : null);
}

function rulesSheet() {
  const s = S.settings, city = cityRuleFor(null), window = knockingWindow();
  return sheet('Help & the rules', () => h('div', { class: 'stack', style: { gap: '0' } },
    kv('Knocking hours', `${window.startLabel} until sunset (${window.endLabel} today)`),
    kv('Sunset warning', `${city?.warnMinutes ?? 15} minutes before`),
    kv('After sunset', `Only the door you're at, for ${city?.graceMinutes ?? 15} min, and it's flagged`),
    kv('Go-backs', `${s.goBacks.maxAttemptsPerSeason} tries per house each season`),
    kv('Not interested', `Rests for ${s.goBacks.notInterestedRestMonths ?? 6} months`),
    kv('Commission', `${Math.round(s.commission.rate * 100)}% once the job is completed, paid and past its cancellation deadline`),
    s.commission.acceleratorEnabled ? kv('Higher rate', `${Math.round(s.commission.acceleratorRate * 100)}% above $${Number(s.commission.acceleratorThreshold).toLocaleString('en-US')} a month`) : null,
    s.commission.leadOverrideEnabled ? kv('Lead bonus', `${Math.round(s.commission.leadOverrideRate * 1000) / 10}% of the team's collected revenue`) : null,
    kv('Deposit', `${Math.round(s.sale.depositRate * 100)}%, fully refundable for ${s.sale.cancelBusinessDays} business days`)));
}

function moreScreen() {
  const theme = recall(THEME_KEY) || 'auto';
  const links = [...(app.moreLinks || [])].sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  const role = S.viewer.admin ? 'Admin' : S.rep.role === 'lead' ? 'Lead' : 'Knocker';
  const training = S.rep.trainingMinutes ? `${Math.round(S.rep.trainingMinutes / 6) / 10} h training` : '';
  return h('div', { class: 'screen' },
    h('div', { class: 'row' },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(S.rep.displayName)),
      h('div', { class: 'grow' }, h('div', { class: 'lead bold' }, S.rep.displayName),
        h('div', { class: 'caption muted' }, [role, S.rep.premiumCleared ? 'Premium cleared' : '', training].filter(Boolean).join(' · '))),
      h('button', { type: 'button', class: 'btn btn--quiet btn--sm', onclick: signOut }, 'Sign out')),
    links.length ? h('div', { class: 'list list--boxed' }, links.map(link => h('a', { class: 'list-row', href: `#${link.route}` },
      icon(link.icon),
      h('span', { class: 'list-row__main' }, h('span', { class: 'list-row__title' }, link.label), h('span', { class: 'list-row__sub' }, typeof link.hint === 'function' ? link.hint() : link.hint)),
      icon('chevronRight')))) : null,
    syncCard(),
    h('div', { class: 'list list--boxed' },
      h('button', { type: 'button', class: 'list-row', onclick: cycleTheme },
        h('span', { class: 'list-row__main' }, h('span', { class: 'list-row__title' }, 'Dark mode')),
        h('span', { class: 'caption muted' }, { auto: 'Auto', light: 'Off', dark: 'On' }[theme]), icon('chevronRight')),
      h('button', { type: 'button', class: 'list-row', onclick: rulesSheet },
        h('span', { class: 'list-row__main' }, h('span', { class: 'list-row__title' }, 'Help & the rules'), h('span', { class: 'list-row__sub' }, 'Knocking hours, go-backs, commission')),
        icon('chevronRight'))),
    h('p', { class: 'caption muted center' }, 'EGC Knock 2.0 · Easy Garage Cleaning · Fort Collins, CO'));
}

function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(recall(THEME_KEY) || 'auto') + 1) % order.length];
  remember(THEME_KEY, next);
  applyTheme(next);
  render();
}

/* ---------- the app object handed to screen modules ---------- */

export const app = { S, api, go, render, registerScreen, enqueue, sync, scheduleSync, houseView, neighborhoodOf, cityRuleFor, currentShift, knockingWindow, saveUi, signOut, outboxApi: () => outbox, refreshPending, syncSummary, moreLinks: [],
  startLocation, onPosition, locationBanner, territoryEmpty, myNeighborhoods, awayLabel };

registerScreen('home', homeScreen, { tab: { label: 'Home', icon: 'home', order: 0 } });
registerScreen('more', moreScreen, { tab: { label: 'More', icon: 'more', order: 40 } });
registerScreen('admin', () => h('div', { class: 'screen' }, h('p', { class: 'muted', role: 'status' }, 'Loading admin…')), { tab: { label: 'Admin', icon: 'shield', order: 90 }, admin: true });

async function loadRepModules() {
  const rep = await import('./knock-rep.js');
  rep.install(app);
  const sale = await import('./knock-sale.js');
  sale.install(app);
  const nativeForm = await import('./knock-native-form.js');
  nativeForm.install(app);
  const stats = await import('./knock-stats-ui.js');
  stats.install(app);
  try {
    const areas = await import('./knock-areas.js');
    areas.install(app);
  } catch (error) { console.warn('EGC Knock: the Choose area screen failed to load.', error); }
  try {
    const map = await import('./knock-map.js');
    map.install(app);
  } catch (error) { console.warn('EGC Knock: the map failed to load; the list works without it.', error); }
}

/* ---------- boot ---------- */

let workerStarted = false;
async function registerWorker() {
  if (workerStarted || !('serviceWorker' in navigator)) return;
  workerStarted = true;
  try {
    const config = await fetch('/crew/sw-config.json', { credentials: 'same-origin', cache: 'no-store' }).then(r => r.ok ? r.json() : {}, () => ({}));
    if (config?.enabled === false) return;
    await navigator.serviceWorker.register('/crew/sw.js', { scope: '/crew/' });
  } catch { /* Offline reloads need the worker; online use works without it. */ }
}

async function boot() {
  applyTheme();
  store = await openKnockStore();
  outbox = createOutbox(store, { transport: httpTransport() });
  outbox.onChange(() => { refreshPending().catch(() => {}); });
  await loadRepModules();
  window.addEventListener('hashchange', route);
  window.addEventListener('online', () => { S.online = true; scheduleSync(0); });
  window.addEventListener('offline', () => { S.online = false; renderChrome(); });
  document.addEventListener('visibilitychange', () => {
    // GPS stops while the app is in the pocket or behind another app, to save the battery.
    if (document.visibilityState !== 'visible') return stopLocation();
    renderChrome(); scheduleSync(500);
    if (S.viewer && S.rep?.status === 'active' && !screens.get(S.route.name)?.admin) startLocation({ retry: true });
  });
  setInterval(() => { renderChrome(); if (S.pending.length && S.online) scheduleSync(0); }, 30000);
  setInterval(() => { if (document.visibilityState === 'visible') renderChrome(); }, 1000);
  S.route = parseRoute();

  // Offline-first: show the phone's copy at once when this account used it recently.
  const cached = offlineViewer();
  if (cached) {
    S.viewer = cached;
    await restoreCache();
    render();
  }
  try {
    const session = await api('/api/hub-auth');
    if (S.viewer && S.viewer.user !== session.user) { S.houses = new Map(); S.pending = []; }
    S.viewer = { ...(S.viewer || {}), user: session.user, displayName: session.displayName || session.user };
    S.authRequired = false;
    await restoreCache();
    await loadServer();
    S.online = true;
    render();
    scheduleSync(0);
  } catch (error) {
    if (error.status === 401) {
      if (!cached) { S.viewer = null; renderSignIn(); }
      else { S.authRequired = true; render(); }
    } else {
      S.online = false;
      if (!cached) mount(main, h('div', { class: 'screen' }, emptyState('wifiOff', 'No signal yet', 'Open EGC Knock once with signal on this phone. After that it works offline.',
        h('button', { type: 'button', class: 'btn btn--primary', onclick: () => location.reload() }, 'Try again'))));
      else render();
    }
  } finally {
    registerWorker();
  }
}

boot();
