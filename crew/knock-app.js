/* EGC Knock: door-to-door canvassing for reps, leads and admins.
   Opens from the phone's own copy (IndexedDB) first so a rep can log doors with no signal, then
   refreshes from /api/knock-*. Every change is an append-only event in the outbox. */
import { h, mount, toast, uuid } from './knock-ui.js';
import { createOutbox, httpTransport, openKnockStore } from './knock-outbox.js';
import { DEFAULT_SETTINGS, mergeSettings } from './knock-settings.js';
import { formatClock, formatCountdown, knockWindow } from './knock-time.js';
import { applyLocalKnock, doorStatus } from './knock-doors.js';
import { shiftTiming } from './knock-stats.js';

const VIEWER_KEY = 'egc-knock:viewer';
const SIGNED_OUT_KEY = 'egc-knock:signed-out-at';
const THEME_KEY = 'egc-knock:theme';
const SESSION_HOURS = 12;

const main = document.getElementById('knock-main');
const tabs = document.getElementById('knock-tabs');
const clock = document.getElementById('knock-clock');
const syncPill = document.getElementById('knock-sync');

const S = {
  online: navigator.onLine,
  viewer: null,
  rep: null,
  settings: mergeSettings({}),
  eligibility: { ok: false, reason: '' },
  territory: { neighborhoods: [] },
  houses: new Map(),
  housesSyncedAt: '',
  shift: null,
  pending: [],
  problems: [],
  position: null,
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
  if (full || data.full) S.houses = new Map();
  const allowed = new Set((data.neighborhoods || []).filter(n => !n.locked).map(n => n.id));
  for (const house of data.houses || []) S.houses.set(house.id, house);
  // Drop houses from territory that is no longer assigned or is now locked.
  for (const [id, house] of S.houses) if (!allowed.has(house.n)) S.houses.delete(id);
  if (data.neighborhoods) S.territory = { neighborhoods: data.neighborhoods };
  S.housesSyncedAt = data.serverTime || '';
  await store.cache.set(cacheKey('houses'), [...S.houses.values()]);
  await store.cache.set(cacheKey('housesSyncedAt'), S.housesSyncedAt);
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
  renderSignIn();
}

function renderSignIn(error = '') {
  tabs.hidden = true; clock.hidden = true; syncPill.hidden = true;
  const form = h('form', { class: 'card accent', onsubmit: async event => {
    event.preventDefault();
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try { await signIn(form.username.value.trim(), form.password.value); }
    catch (err) { renderSignIn(err.message); }
    finally { button.disabled = false; }
  } },
  h('span', { class: 'eyebrow' }, 'Canvassing sign in'),
  h('h1', {}, 'Knock doors with EGC'),
  h('p', { class: 'muted' }, 'Use your EGC Hub username and password. New here? Ask Zac for a Hub account first.'),
  error ? h('p', { class: 'notice error', role: 'alert' }, error) : null,
  h('label', { for: 'username' }, 'Username'),
  h('input', { id: 'username', name: 'username', autocomplete: 'username', autocapitalize: 'none', required: true }),
  h('label', { for: 'password' }, 'Password'),
  h('input', { id: 'password', name: 'password', type: 'password', autocomplete: 'current-password', required: true }),
  h('p', {}),
  h('button', { type: 'submit', class: 'primary wide' }, 'Sign in'));
  mount(main, form);
}

/* ---------- routing and rendering ---------- */

export function registerScreen(name, render, { tab = null, admin = false, active = true } = {}) {
  screens.set(name, { render, tab, admin, active });
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
  renderChrome();
  if (!S.rep) { mount(main, h('p', { class: 'loading' }, S.online ? 'Loading your canvassing profile…' : 'Connect once to load your canvassing profile.')); return; }
  if (S.rep.status !== 'active') return renderWaiting();
  const screen = screens.get(S.route.name) || screens.get('home');
  if (screen.admin && !S.viewer.admin) return mount(main, h('p', { class: 'notice error' }, 'Only admins can open that screen.'));
  if (screen.admin && !modules.admin) ensureAdmin().then(() => { if (modules.admin) render(); });
  try {
    mount(main, screen.render(app, S.route.params));
  } catch (error) {
    mount(main, h('section', { class: 'card' }, h('h1', {}, 'Something went wrong'), h('p', { class: 'notice error' }, error.message || String(error)), h('button', { type: 'button', onclick: () => location.reload() }, 'Reload')));
  }
  renderTabs();
}

function renderWaiting() {
  tabs.hidden = true;
  const inactive = S.rep.status === 'inactive';
  mount(main, h('section', { class: 'card accent' },
    h('span', { class: 'eyebrow' }, inactive ? 'Access turned off' : 'Waiting for approval'),
    h('h1', {}, inactive ? 'Canvassing is turned off for you' : `Thanks, ${S.rep.displayName}`),
    h('p', {}, inactive ? 'Your canvassing access was turned off. Talk to Zac if this is a mistake.' : 'An admin has to approve your canvassing account before you can see territory or log doors. You will not lose anything while you wait.'),
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'primary', onclick: () => sync({ full: true }) }, 'Check again'),
      h('button', { type: 'button', onclick: signOut }, 'Sign out'))));
}

function renderTabs() {
  const items = [...screens.entries()].filter(([, s]) => s.tab && (!s.admin || S.viewer?.admin)).sort((a, b) => (a[1].tab.order ?? 50) - (b[1].tab.order ?? 50));
  tabs.hidden = !items.length;
  mount(tabs, items.map(([name, s]) => h('a', { href: `#${name}`, 'aria-current': S.route.name === name || (name === 'admin' && S.route.name.startsWith('admin')) ? 'page' : false },
    h('span', { class: 'glyph', 'aria-hidden': 'true' }, s.tab.glyph), s.tab.label)));
}

export function knockingWindow(house = null) {
  return knockWindow(cityRuleFor(house), Date.now());
}

function renderChrome() {
  if (!S.viewer) return;
  const window = knockingWindow(S.ui.houseId ? S.houses.get(S.ui.houseId) : null);
  clock.hidden = false;
  clock.className = `clock${window.warning ? ' warn' : ''}${window.phase === 'grace' || window.phase === 'closed' ? ' closed' : ''}`;
  clock.textContent = window.phase === 'before' ? `Knocking opens ${window.startLabel} · sunset ${window.endLabel}`
    : window.phase === 'open' ? `Sunset ${window.endLabel} · ${formatCountdown(window.msToEnd)} left`
    : window.phase === 'grace' ? `Past sunset · finish the last door by ${formatClock(window.graceEndAt)}` : `Sunset was ${window.endLabel} · done for today`;
  syncPill.hidden = false;
  const pending = S.pending.length, problems = S.problems.length;
  syncPill.className = `sync-pill${problems ? ' problem' : !S.online ? ' offline' : ''}`;
  syncPill.textContent = problems ? `${problems} problem${problems === 1 ? '' : 's'}`
    : S.syncState === 'syncing' ? 'Syncing…'
    : S.authRequired ? 'Sign in to sync'
    : pending ? `${pending} to sync${S.online ? '' : ' · offline'}`
    : S.online ? 'Synced' : 'Offline';
}

/* ---------- home ---------- */

function homeScreen() {
  const shift = currentShift();
  const nbhds = S.territory.neighborhoods;
  const window = knockingWindow();
  return h('div', {},
    S.authRequired ? h('section', { class: 'card accent' }, h('p', { class: 'notice' }, 'Your sign-in expired. Your doors are safe on this phone; sign in to sync them.'), h('button', { type: 'button', class: 'primary', onclick: () => renderSignIn() }, 'Sign in again')) : null,
    h('section', { class: 'card' },
      h('span', { class: 'eyebrow' }, S.viewer.admin ? 'Admin' : S.rep.role === 'lead' ? 'Lead' : 'Knocker'),
      h('h1', {}, `Hi, ${S.rep.displayName}`),
      h('p', { class: 'muted' }, window.phase === 'before' ? `Knocking opens at ${window.startLabel}. Sunset is ${window.endLabel}.`
        : window.phase === 'open' ? `Knock until sunset at ${window.endLabel}.` : `Sunset was ${window.endLabel}. Knocking is closed for today.`),
      S.eligibility.ok ? null : h('p', { class: 'notice' }, S.eligibility.reason),
      shift && !app.shiftCard ? h('p', { class: 'notice ok' }, `Shift running since ${formatClock(Date.parse(shift.startedAt))}.`) : null),
    app.shiftCard ? app.shiftCard() : null,
    h('section', { class: 'card' },
      h('h2', {}, 'Your territory'),
      nbhds.length ? h('ul', { class: 'list' }, nbhds.map(n => h('li', {},
        h('div', { style: { flex: '1' } }, h('b', {}, n.name), h('div', { class: 'muted' }, n.streets ? `Streets: ${n.streets.join(', ')}` : 'Whole neighborhood')),
        n.tier === 'Premium' ? h('span', { class: 'badge premium' }, 'Premium') : null,
        n.locked ? h('span', { class: 'badge locked', title: n.lockReason }, n.lockReason) : h('span', { class: 'badge ok' }, 'Open'))))
        : h('p', { class: 'muted' }, 'Nothing is assigned to you yet. An admin assigns neighborhoods or streets.')),
    h('section', { class: 'card' },
      h('h2', {}, 'This phone'),
      h('p', {}, S.pending.length ? `${S.pending.length} change${S.pending.length === 1 ? '' : 's'} waiting to sync.` : 'Everything is synced.'),
      store?.persistent === false ? h('p', { class: 'notice error' }, 'This browser is not saving offline data. Keep signal or use the installed app.') : null,
      problemsList(),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => sync({ full: true }) }, 'Sync now'),
        h('button', { type: 'button', onclick: cycleTheme }, `Theme: ${recall(THEME_KEY) || 'auto'}`),
        h('button', { type: 'button', class: 'ghost', onclick: signOut }, 'Sign out'))));
}

function problemsList() {
  if (!S.problems.length) return null;
  return h('div', {},
    h('p', { class: 'notice error' }, 'These changes were refused by the server and were not saved:'),
    h('ul', { class: 'list problems' }, S.problems.map(event => h('li', {},
      h('div', { style: { flex: '1' } }, h('b', {}, event.type.replace('.', ' ')), h('div', { class: 'muted' }, event.error?.message || 'Refused')),
      h('button', { type: 'button', onclick: async () => { await outbox.retry(event.id); await refreshPending(); scheduleSync(0); } }, 'Retry'),
      h('button', { type: 'button', class: 'danger', onclick: async () => { await outbox.remove(event.id); await refreshPending(); render(); } }, 'Discard')))));
}

function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(recall(THEME_KEY) || 'auto') + 1) % order.length];
  remember(THEME_KEY, next);
  applyTheme(next);
  render();
}

/* ---------- the app object handed to screen modules ---------- */

export const app = { S, api, go, render, registerScreen, enqueue, sync, scheduleSync, houseView, neighborhoodOf, cityRuleFor, currentShift, knockingWindow, saveUi, signOut, outboxApi: () => outbox, refreshPending };

registerScreen('home', homeScreen, { tab: { label: 'Home', glyph: '⌂', order: 0 } });
registerScreen('admin', () => h('p', { class: 'loading' }, 'Loading admin…'), { tab: { label: 'Admin', glyph: '⚙', order: 90 }, admin: true });

async function loadRepModules() {
  const rep = await import('./knock-rep.js');
  rep.install(app);
  const sale = await import('./knock-sale.js');
  sale.install(app);
  try {
    const map = await import('./knock-map.js');
    map.install(app);
  } catch { /* The list view works without the map module. */ }
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
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { renderChrome(); scheduleSync(500); } });
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
      if (!cached) mount(main, h('section', { class: 'card' }, h('h1', {}, 'No connection'), h('p', {}, 'Open canvassing once with signal on this phone. After that it works offline.'), h('button', { type: 'button', class: 'primary', onclick: () => location.reload() }, 'Try again')));
      else render();
    }
  } finally {
    registerWorker();
  }
}

boot();
