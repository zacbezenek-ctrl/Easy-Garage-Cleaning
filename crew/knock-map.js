/* Territory map: every assigned house colored by its latest outcome, the rep's GPS position and the
   nearest house not yet knocked. Leaflet (bundled as crew/knock-leaflet.*) loads on first open.
   Tiles come from settings.map.tileUrl and need signal; the houses and colors work offline. */
import { h, mount, toast } from './knock-ui.js';
import { OUTCOME_COLORS, houseLabel, nearestSuggestion } from './knock-doors.js';
import { OUTCOME_LABELS } from './knock-settings.js';
import { colorFor, houseEntries, selectHouse, statusText } from './knock-rep.js';

let app;
let L = null;
let map = null;
let container = null;
let tiles = null;
let tileUrl = '';
const markers = new Map();
let gpsDot = null, gpsRing = null, suggestion = null, fitted = false, refresher = 0;

function loadLeaflet() {
  if (globalThis.L) return Promise.resolve(globalThis.L);
  if (!document.querySelector('link[data-knock-leaflet]')) {
    document.head.append(h('link', { rel: 'stylesheet', href: '/crew/knock-leaflet.css?v=1.9.4', 'data-knock-leaflet': '' }));
  }
  return new Promise((resolve, reject) => {
    const script = h('script', { src: '/crew/knock-leaflet.js?v=1.9.4' });
    script.onload = () => resolve(globalThis.L);
    script.onerror = () => reject(new Error('The map library could not load. The list view works without it.'));
    document.head.append(script);
  });
}

const dark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);

async function ensureMap() {
  L = await loadLeaflet();
  const settings = app.S.settings.map;
  if (!map) {
    map = L.map(container, { preferCanvas: true, zoomControl: true, tap: true });
    map.attributionControl.setPrefix('');
    map.on('zoomend', () => updateMarkers());
  }
  if (tileUrl !== settings.tileUrl) {
    tiles?.remove();
    tiles = L.tileLayer(settings.tileUrl, { maxZoom: settings.maxZoom || 19, attribution: settings.attribution }).addTo(map);
    tileUrl = settings.tileUrl;
  }
  map.invalidateSize();
}

function popupFor(entry) {
  const box = h('div', { class: 'stack', style: { minWidth: '190px' } },
    h('b', {}, houseLabel(entry.house)),
    h('div', {}, statusText(entry)),
    entry.summary?.lastOutcome ? h('div', { class: 'muted' }, `Last: ${OUTCOME_LABELS[entry.summary.lastOutcome]}`) : null,
    h('button', { type: 'button', class: 'primary', onclick: async () => { map.closePopup(); await selectHouse(entry.house); app.go('knock'); } }, entry.status.knockable ? 'Knock this house' : 'Open this house'));
  return box;
}

// Houses sit 15-25 m apart: small dots when zoomed out, finger-sized targets on the street.
const radiusFor = zoom => (zoom >= 18 ? 10 : zoom >= 17 ? 7 : zoom >= 16 ? 4.5 : 3);

function updateMarkers() {
  if (!map) return;
  const entries = houseEntries().filter(e => Number.isFinite(e.house.lat) && Number.isFinite(e.house.lng));
  const selected = app.S.ui.houseId;
  const position = app.S.position;
  if (!fitted) {
    // The map needs a view before any marker is drawn. Open on the rep (or the selected house)
    // at street level; "Whole territory" zooms out.
    fitted = true;
    const anchor = entries.find(e => e.house.id === selected) || entries[0];
    const city = app.cityRuleFor(null);
    if (position) map.setView([position.lat, position.lng], 17);
    else if (anchor) map.setView([anchor.house.lat, anchor.house.lng], 17);
    else map.setView([city.latitude, city.longitude], 13);
  }
  const stroke = dark() ? '#0a1120' : '#13203a';
  const base = radiusFor(map.getZoom());
  const seen = new Set();
  for (const entry of entries) {
    seen.add(entry.house.id);
    const style = {
      radius: entry.house.id === selected ? base + 4 : base,
      color: entry.house.id === selected ? '#e8581c' : stroke,
      weight: entry.house.id === selected ? 4 : base > 4 ? 2 : 1,
      fillColor: colorFor(entry),
      fillOpacity: entry.status.knockable || entry.summary?.lastOutcome ? 0.95 : 0.45,
    };
    let marker = markers.get(entry.house.id);
    if (!marker) {
      marker = L.circleMarker([entry.house.lat, entry.house.lng], style).addTo(map);
      marker.on('click', () => marker.bindPopup(popupFor(houseEntries().find(e => e.house.id === entry.house.id) || entry)).openPopup());
      markers.set(entry.house.id, marker);
    } else {
      marker.setStyle(style);
      marker.setRadius(style.radius);
    }
  }
  for (const [id, marker] of markers) if (!seen.has(id)) { marker.remove(); markers.delete(id); }

  if (position) {
    const at = [position.lat, position.lng];
    if (!gpsDot) {
      gpsRing = L.circle(at, { radius: position.accuracy || 20, color: '#2563eb', weight: 1, fillOpacity: 0.12 }).addTo(map);
      gpsDot = L.circleMarker(at, { radius: 8, color: '#ffffff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).addTo(map);
    } else {
      gpsDot.setLatLng(at); gpsRing.setLatLng(at); gpsRing.setRadius(position.accuracy || 20);
    }
  }
  const near = nearestSuggestion(entries.filter(e => e.status.knockable), position);
  if (near) {
    const at = [near.house.lat, near.house.lng];
    if (!suggestion) suggestion = L.circleMarker(at, { radius: 17, color: '#e8581c', weight: 4, fill: false, interactive: false }).addTo(map);
    else suggestion.setLatLng(at);
  } else if (suggestion) { suggestion.remove(); suggestion = null; }
  return near;
}

function mapScreen() {
  if (!container) container = h('div', { id: 'knock-map', role: 'application', 'aria-label': 'Map of your territory' });
  const status = h('p', { class: 'muted' }, 'Loading the map…');
  clearInterval(refresher);
  refresher = setInterval(() => { if (location.hash.startsWith('#map')) updateMarkers(); else clearInterval(refresher); }, 5000);
  queueMicrotask(async () => {
    try {
      await ensureMap();
      const near = updateMarkers();
      mount(status, near ? `Nearest not knocked: ${houseLabel(near.house)}, ${Math.round(near.meters)} m away.` : app.S.position ? 'Every house near you is done or blocked.' : 'Turn on location to see the nearest house to knock.');
    } catch (error) {
      mount(status, h('span', { class: 'notice error' }, error.message));
    }
  });
  const legend = [['none', 'Not knocked'], ['no_answer', 'No answer'], ['come_back', 'Come back'], ['not_interested', 'Not interested'], ['look', 'Look'], ['sold', 'Sold'], ['blocked', 'No-knock']];
  return h('div', {},
    h('div', { class: 'map-tools' },
      h('button', { type: 'button', onclick: () => { const p = app.S.position; if (p && map) map.setView([p.lat, p.lng], 18); else toast('Location is not available yet. Allow location for this site.', { tone: 'bad' }); } }, 'Center on me'),
      h('button', { type: 'button', class: 'primary', onclick: async () => {
        const near = nearestSuggestion(houseEntries().filter(e => e.status.knockable), app.S.position);
        if (!near) return;
        await selectHouse(near.house);
        app.go('knock');
      } }, 'Knock nearest'),
      h('button', { type: 'button', onclick: () => {
        const points = houseEntries().filter(e => Number.isFinite(e.house.lat)).map(e => [e.house.lat, e.house.lng]);
        if (map && points.length) map.fitBounds(L.latLngBounds(points), { padding: [24, 24] });
      } }, 'Whole territory')),
    container, status,
    h('div', { class: 'legend' }, legend.map(([key, label]) => h('span', {}, h('span', { class: 'chip', style: { background: OUTCOME_COLORS[key] } }), label))));
}

export function install(appApi) {
  app = appApi;
  app.registerScreen('map', mapScreen, { tab: { label: 'Map', glyph: '◎', order: 30 } });
}
