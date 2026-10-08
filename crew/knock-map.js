/* Territory map: every assigned house colored and lettered by its latest outcome, the rep's GPS
   position and the nearest house not yet knocked. Leaflet (bundled as crew/knock-leaflet.*) loads on
   first open. Tiles come from settings.map.tileUrl and need signal; the houses and colors work offline.
   Zoomed out, houses are small canvas dots; at street level the houses on screen become lettered
   dots (N, C, X, L, $, S) so color is never the only signal. */
import { h, mount, toast, icon, dot, distanceLabel, OUTCOME_DOT } from './knock-ui.js';
import { houseLabel, nearestSuggestion } from './knock-doors.js';
import { OUTCOME_LABELS } from './knock-settings.js';
import { formatClock, zonedDate } from './knock-time.js';
import { colorFor, dotKind, houseEntries, selectHouse, statusText } from './knock-rep.js';

let app;
let L = null;
let map = null;
let container = null;
let tiles = null;
let tileUrl = '';
let canvasLayer = null, pinLayer = null;
const circles = new Map(), pins = new Map();
let gpsDot = null, gpsRing = null, suggestion = null, fitted = false, refresher = 0;
let cardHouseId = null;
let cardBox = null;
// Houses sit 15-25 m apart: about 35-55 px at zoom 18, where lettered dots have room.
const STREET_ZOOM = 18;

function loadLeaflet() {
  if (globalThis.L) return Promise.resolve(globalThis.L);
  if (!document.querySelector('link[data-knock-leaflet]')) {
    document.head.append(h('link', { rel: 'stylesheet', href: '/crew/knock-leaflet.css?v=1.9.4', 'data-knock-leaflet': '' }));
  }
  return new Promise((resolve, reject) => {
    const script = h('script', { src: '/crew/knock-leaflet.js?v=1.9.4' });
    script.onload = () => resolve(globalThis.L);
    script.onerror = () => reject(new Error('The map couldn\'t load. The list works without it.'));
    document.head.append(script);
  });
}

const dark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);

async function ensureMap() {
  L = await loadLeaflet();
  const settings = app.S.settings.map;
  if (!map) {
    map = L.map(container, { preferCanvas: true, zoomControl: false, tap: true });
    map.attributionControl.setPrefix('');
    canvasLayer = L.layerGroup().addTo(map);
    pinLayer = L.layerGroup().addTo(map);
    map.on('zoomend moveend', () => updateMarkers());
    map.on('click', () => { if (cardHouseId) { cardHouseId = null; renderCard(); } });
  }
  if (tileUrl !== settings.tileUrl) {
    tiles?.remove();
    tiles = L.tileLayer(settings.tileUrl, { maxZoom: settings.maxZoom || 19, attribution: settings.attribution }).addTo(map);
    tileUrl = settings.tileUrl;
  }
  container.classList.toggle('map--dark', dark());
  map.invalidateSize();
}

function openCard(houseId) {
  cardHouseId = houseId;
  renderCard();
  updateMarkers();
}

function renderCard() {
  if (!cardBox) return;
  const entry = cardHouseId ? houseEntries().find(e => e.house.id === cardHouseId) : null;
  cardBox.hidden = !entry;
  if (!entry) return mount(cardBox);
  const s = entry.summary;
  mount(cardBox,
    h('div', { class: 'row row--between row--top' },
      h('div', { class: 'grow' }, h('div', { class: 'serif', style: { fontSize: '20px' } }, houseLabel(entry.house)),
        h('div', { class: 'row', style: { gap: '6px', fontSize: '15px' } }, dot(dotKind(entry)), statusText(entry))),
      h('button', { type: 'button', class: 'ico-btn', 'aria-label': 'Close', onclick: () => { cardHouseId = null; renderCard(); updateMarkers(); } }, icon('close'))),
    s?.lastOutcome && s.lastAt ? h('div', { class: 'caption muted' }, `Last outcome: ${OUTCOME_LABELS[s.lastOutcome]} · ${new Date(`${zonedDate(s.lastAt)}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })} · ${formatClock(Date.parse(s.lastAt))}`) : null,
    h('button', { type: 'button', class: `btn btn--block ${entry.status.knockable ? 'btn--primary' : 'btn--secondary'}`, onclick: async () => {
      await selectHouse(entry.house);
      cardHouseId = null;
      app.go('knock');
    } }, entry.status.knockable ? 'Knock this house' : 'Open this house'));
}

// Canvas dots below street level: small when zoomed out, finger-sized one step out.
const radiusFor = zoom => (zoom >= 17 ? 7 : zoom >= 16 ? 4.5 : 3);

function pinIcon(entry, selected) {
  const [cls] = OUTCOME_DOT[dotKind(entry)] || OUTCOME_DOT.none;
  const el = h('span', { class: `map-pin__dot${selected ? ' map-pin--selected' : ''}` }, dot(dotKind(entry), { large: true }));
  return { key: `${cls}${selected ? ':selected' : ''}`, icon: L.divIcon({ html: el, className: 'map-pin', iconSize: [36, 36], iconAnchor: [18, 18] }) };
}

function updateMarkers() {
  if (!map) return null;
  const entries = houseEntries().filter(e => Number.isFinite(e.house.lat) && Number.isFinite(e.house.lng));
  const selected = cardHouseId || app.S.ui.houseId;
  const position = app.S.position;
  if (!fitted) {
    // The map needs a view before any marker is drawn. Open on the rep (or the selected house)
    // at street level; "Whole territory" zooms out.
    fitted = true;
    const anchor = entries.find(e => e.house.id === selected) || entries[0];
    const city = app.cityRuleFor(null);
    if (position) map.setView([position.lat, position.lng], STREET_ZOOM);
    else if (anchor) map.setView([anchor.house.lat, anchor.house.lng], STREET_ZOOM);
    else map.setView([city.latitude, city.longitude], 13);
  }
  const zoom = map.getZoom();
  const street = zoom >= STREET_ZOOM;
  const byId = new Map(entries.map(e => [e.house.id, e]));
  if (street) {
    // Lettered dots for the houses on screen only; nothing is drawn twice.
    for (const marker of circles.values()) marker.remove();
    circles.clear();
    const bounds = map.getBounds().pad(0.15);
    const visible = new Set();
    for (const entry of entries) {
      if (!bounds.contains([entry.house.lat, entry.house.lng])) continue;
      visible.add(entry.house.id);
      const { key, icon: pin } = pinIcon(entry, entry.house.id === selected);
      const current = pins.get(entry.house.id);
      if (current && current.key === key) continue;
      current?.marker.remove();
      const marker = L.marker([entry.house.lat, entry.house.lng], { icon: pin, keyboard: true, title: `${houseLabel(entry.house)}: ${statusText(entry)}`, riseOnHover: true })
        .on('click', event => { L.DomEvent.stopPropagation(event); openCard(entry.house.id); });
      marker.addTo(pinLayer);
      pins.set(entry.house.id, { key, marker });
    }
    for (const [id, pin] of pins) if (!visible.has(id) || !byId.has(id)) { pin.marker.remove(); pins.delete(id); }
  } else {
    for (const pin of pins.values()) pin.marker.remove();
    pins.clear();
    const stroke = dark() ? '#0a1120' : '#13203a';
    const base = radiusFor(zoom);
    for (const entry of entries) {
      const isSelected = entry.house.id === selected;
      const style = {
        radius: isSelected ? base + 3 : base, color: isSelected ? '#e8581c' : stroke, weight: isSelected ? 3 : 1,
        fillColor: colorFor(entry), fillOpacity: entry.status.knockable || entry.summary?.lastOutcome ? 0.95 : 0.45,
      };
      let marker = circles.get(entry.house.id);
      if (!marker) {
        marker = L.circleMarker([entry.house.lat, entry.house.lng], style).on('click', event => { L.DomEvent.stopPropagation(event); openCard(entry.house.id); });
        marker.addTo(canvasLayer);
        circles.set(entry.house.id, marker);
      } else {
        marker.setStyle(style);
        marker.setRadius(style.radius);
      }
    }
    for (const [id, marker] of circles) if (!byId.has(id)) { marker.remove(); circles.delete(id); }
  }

  if (position) {
    const at = [position.lat, position.lng];
    if (!gpsDot) {
      gpsRing = L.circle(at, { radius: position.accuracy || 20, color: '#2563eb', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
      gpsDot = L.circleMarker(at, { radius: 9, color: '#ffffff', weight: 3, fillColor: '#2563eb', fillOpacity: 1, interactive: false }).addTo(map);
    } else {
      gpsDot.setLatLng(at); gpsRing.setLatLng(at); gpsRing.setRadius(position.accuracy || 20);
    }
  }
  const near = nearestSuggestion(entries.filter(e => e.status.knockable), position);
  if (near) {
    const at = [near.house.lat, near.house.lng];
    if (!suggestion) suggestion = L.circleMarker(at, { radius: 22, color: '#e8581c', weight: 4, fill: false, interactive: false }).addTo(map);
    else suggestion.setLatLng(at);
  } else if (suggestion) { suggestion.remove(); suggestion = null; }
  return near;
}

function mapScreen() {
  if (!container) container = h('div', { id: 'knock-map', role: 'application', 'aria-label': 'Map of your territory. Tap a house to open it.' });
  cardBox = h('div', { class: 'map__card', hidden: true, role: 'dialog', 'aria-label': 'House' });
  const nearest = h('button', { type: 'button', class: 'btn btn--primary map__nearest', disabled: true }, icon('door'), 'Loading the map…');
  const status = h('p', { class: 'sr-only', role: 'status' });
  clearInterval(refresher);
  const refresh = () => {
    const near = updateMarkers();
    mount(nearest, icon('door'), near ? `Knock nearest · ${houseLabel(near.house)} · ${distanceLabel(near.meters)}` : app.S.position ? 'Every house near you is done' : 'Open the Knock screen');
    nearest.disabled = false;
    nearest.onclick = async () => {
      if (near) await selectHouse(near.house);
      app.go('knock');
    };
    mount(status, near ? `Nearest not knocked: ${houseLabel(near.house)}, ${distanceLabel(near.meters)} away.` : app.S.position ? 'Every house near you is done or blocked.' : 'Turn on location to see the nearest house to knock.');
    renderCard();
  };
  refresher = setInterval(() => { if (location.hash.startsWith('#map')) refresh(); else clearInterval(refresher); }, 5000);
  queueMicrotask(async () => {
    try {
      await ensureMap();
      refresh();
    } catch (error) {
      mount(nearest, icon('list'), 'Open the list instead');
      nearest.disabled = false;
      nearest.onclick = () => app.go('list');
      mount(status, error.message);
      toast(error.message, { tone: 'bad' });
    }
  });
  const legend = [['none', 'Not knocked'], ['no_answer', 'No answer'], ['come_back', 'Come back'], ['not_interested', 'Not interested'], ['look', 'Look'], ['sold', 'Sold'], ['blocked', 'Skipped / no-knock']];
  return h('div', { class: 'map-screen' },
    h('div', { class: 'legend', 'aria-label': 'Legend' }, legend.map(([key, label]) => h('span', {}, dot(key), label))),
    h('div', { class: 'map' },
      container,
      h('div', { class: 'map__ctl' },
        h('button', { type: 'button', class: 'btn btn--secondary', onclick: () => {
          const p = app.S.position;
          if (p && map) map.setView([p.lat, p.lng], 18);
          else toast('Location isn\'t available yet', { tone: 'bad', sub: 'Allow location for this site.' });
        } }, icon('crosshair'), 'Center on me'),
        h('button', { type: 'button', class: 'btn btn--secondary', onclick: () => {
          const points = houseEntries().filter(e => Number.isFinite(e.house.lat)).map(e => [e.house.lat, e.house.lng]);
          if (map && points.length) map.fitBounds(L.latLngBounds(points), { padding: [24, 24] });
        } }, icon('map'), 'Whole territory')),
      cardBox, nearest, status));
}

export function install(appApi) {
  app = appApi;
  app.registerScreen('map', mapScreen, { tab: { label: 'Map', icon: 'map', order: 30 } });
}
