/** Drive-time estimates between consecutive dispatch stops.
 * EGC_DISPATCH_TRAVEL_ESTIMATES selects the source:
 *   off (default)  manual per-job travel buffers only (historical behavior).
 *   offline        built-in Northern Colorado ZIP centroid table. No key, no
 *                  network request and no address leaves the Hub.
 *   google         Google Distance Matrix through an injected fetcher when
 *                  GOOGLE_MAPS_SERVER_API_KEY is set; results are cached in
 *                  dispatchTravelCache/{sha256(from|to)} (no address stored,
 *                  expiresAt is a Firestore timestamp for a TTL policy). At
 *                  most 25 Google calls plus one batched cache read and one
 *                  batched cache write per request; saves only read the cache.
 *                  A missing key, spent budget or failed request uses offline.
 * An estimate never shortens a job's manual buffer: required = max(buffer,
 * estimate). Unknown locations use the buffer only, so no free capacity is
 * invented. EGC_DISPATCH_BLOCK_TRAVEL_SHORT=true makes a gap shorter than the
 * estimated drive a dispatch_conflict; by default it is only a warning. The
 * owner's blockTravelShort (dispatch-settings.js) does the same, and
 * travel.blockTravelShort below reports either.
 *
 * GET /api/dispatch-travel?date=YYYY-MM-DD&employeeId=optional (manager only)
 * => {ok,timeZone,date,asOf,travel:{mode,requestedMode,blockTravelShort},
 *     coverage:{complete,asOf},employees:[{employeeId,name,active,complete,
 *     jobs:[{id,type,customer,title,address,date,time,endDate,endTime,startAt,
 *     endAt,status,travelBufferMinutes}],legs:[{fromJobId,toJobId,gapMinutes,
 *     bufferMinutes,estimatedMinutes,estimateSource,requiredMinutes,
 *     shortByMinutes,status:'ok'|'short'|'same_property'|'overlap'}],
 *     totals:{stops,legs,shortLegs,estimatedDriveMinutes,unestimatedLegs}}],
 *     warnings:[{code,message,...}]}. legs[i] joins jobs[i] and jobs[i+1].
 */
import { requireDispatcher } from './dispatch-service.js';
import { dispatchRuleSettings } from './dispatch-settings.js';
import { assignmentKey } from './job-assignment.js';
import { sameOperationalProperty } from './dispatch-lineage.js';
import { scheduleCrewIds } from './dispatch-conflicts.js';
import { DISPATCH_TIME_ZONE } from './dispatch-contract.js';
import { validDate, denverToday, scheduleInterval, occupiedDays } from './dispatch-time.js';
import { jobSegments } from './dispatch-segments.js';
import { jobsForWindow, dayWindow } from './dispatch-window-reads.js';

export const TRAVEL_ROAD_FACTOR = 1.35, TRAVEL_AVERAGE_MPH = 35, TRAVEL_OVERHEAD_MINUTES = 5, TRAVEL_WINDOW_MINUTES = 240;
const CACHE_TTL_MS = 30 * 86400000, GOOGLE_PAIR_LIMIT = 25, GOOGLE_CONCURRENCY = 5, CACHE_READ_LIMIT = 200, GOOGLE_TIMEOUT_MS = 5000, MODES = new Set(['off','offline','google']);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const closed = row => ['cancelled','canceled','completed','invoiced','paid','review_requested','closed','noshow','no_show','no-show'].includes(String(row?.pipelineStatus || row?.status || '').toLowerCase());
const stop = row => Boolean(row && !row.recordType && ['job','walkthrough','cleanout','reorg'].includes(row.type) && typeof row.id === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(row.id) && !/^(_egc_|secure_)/.test(row.id) && !closed(row));
const roundUp = minutes => Math.ceil(minutes / 5 - 1e-9) * 5;
const hex = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2,'0')).join('');

/** Approximate population-center coordinates for Northern Colorado ZIP codes
 * (GeoNames/USPS place points cross-checked with Census ZCTA internal points).
 * Covers Fort Collins, Loveland, Windsor, Wellington, Timnath, Severance,
 * LaPorte, Berthoud, Johnstown, Greeley, Longmont, Estes Park, Evans, Eaton and
 * the adjacent communities crews reach from those towns. PO-box ZIPs use their
 * town center. */
export const TRAVEL_ZIP_CENTROIDS = Object.freeze({
  80501:[40.1779,-105.1009,'Longmont'],80502:[40.1672,-105.1019,'Longmont'],80503:[40.1559,-105.1624,'Longmont'],80504:[40.1656,-105.0292,'Longmont'],
  80511:[40.3658,-105.5142,'Estes Park'],80512:[40.6265,-105.2610,'Bellvue'],80513:[40.2993,-105.1055,'Berthoud'],80514:[40.0836,-104.9297,'Dacono'],
  80515:[40.4275,-105.3831,'Drake'],80516:[40.0503,-105.0500,'Erie'],80517:[40.3658,-105.5142,'Estes Park'],80520:[40.1125,-104.9366,'Firestone'],
  80521:[40.5813,-105.1039,'Fort Collins'],80522:[40.6429,-105.0570,'Fort Collins'],80523:[40.5853,-105.0844,'Fort Collins'],80524:[40.5986,-105.0581,'Fort Collins'],
  80525:[40.5384,-105.0547,'Fort Collins'],80526:[40.5473,-105.1076,'Fort Collins'],80527:[40.5853,-105.0844,'Fort Collins'],80528:[40.4961,-105.0002,'Fort Collins'],
  80530:[40.0978,-104.9293,'Frederick'],80532:[40.4578,-105.4470,'Glen Haven'],80533:[40.1815,-105.2327,'Hygiene'],80534:[40.3355,-104.9236,'Johnstown'],
  80535:[40.6347,-105.1488,'LaPorte'],80536:[40.8701,-105.3766,'Livermore'],80537:[40.3849,-105.0916,'Loveland'],80538:[40.4262,-105.0900,'Loveland'],
  80539:[40.3978,-105.0750,'Loveland'],80540:[40.2357,-105.3231,'Lyons'],80541:[40.4875,-105.2108,'Masonville'],80542:[40.2347,-104.9994,'Mead'],
  80543:[40.3294,-104.8552,'Milliken'],80544:[40.1039,-105.1708,'Niwot'],80545:[40.8659,-105.6893,'Red Feather Lakes'],80546:[40.5250,-104.8505,'Severance'],
  80547:[40.5291,-104.9853,'Timnath'],80549:[40.7255,-105.0318,'Wellington'],80550:[40.4837,-104.8994,'Windsor'],80551:[40.4775,-104.9014,'Windsor'],
  80553:[40.5853,-105.0844,'Fort Collins'],80610:[40.5938,-104.7356,'Ault'],80615:[40.5273,-104.7146,'Eaton'],80620:[40.3803,-104.6971,'Evans'],
  80623:[40.2854,-104.7825,'Gilcrest'],80631:[40.4233,-104.7091,'Greeley'],80632:[40.3766,-104.7629,'Greeley'],80633:[40.4233,-104.7091,'Greeley'],
  80634:[40.4109,-104.7541,'Greeley'],80638:[40.4233,-104.7091,'Greeley'],80639:[40.3993,-104.7017,'Greeley'],80644:[40.3963,-104.5288,'Kersey'],80645:[40.3486,-104.7019,'La Salle'],
  80646:[40.4824,-104.7054,'Lucerne'],80648:[40.7265,-104.7850,'Nunn'],80650:[40.6359,-104.7638,'Pierce'],80651:[40.2131,-104.8028,'Platteville'],
});

const ABBREVIATIONS = {street:'st',avenue:'ave',av:'ave',drive:'dr',road:'rd',court:'ct',lane:'ln',boulevard:'blvd',circle:'cir',place:'pl',parkway:'pkwy',highway:'hwy',trail:'trl',terrace:'ter',north:'n',south:'s',east:'e',west:'w',northeast:'ne',northwest:'nw',southeast:'se',southwest:'sw',colorado:'co',apartment:'apt',suite:'ste'};
/** Comparison key only; never shown to people or sent to a provider. */
export function normalizeAddress(value) {
  if (typeof value !== 'string') return '';
  const tokens = value.normalize('NFKC').toLowerCase().replace(/\b(\d{5})-\d{4}\b/g,'$1').replace(/[^a-z0-9]+/g,' ').trim().split(' ').filter(Boolean).map(token => ABBREVIATIONS[token] || token);
  if (tokens.at(-2) === 'united' && tokens.at(-1) === 'states') tokens.splice(-2);
  else if (['usa','us'].includes(tokens.at(-1))) tokens.pop();
  return tokens.join(' ');
}

/** A ZIP after the state, or a trailing ZIP; never a leading house number or
 * a trailing PO box number. */
export function addressZip(value) {
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFKC'), state = /\b(?:co|colo|colorado)\.?,?\s+(\d{5})(?:-\d{4})?\b/i.exec(text);
  if (state) return state[1];
  const trailing = /(?:^|[\s,])(\d{5})(?:-\d{4})?\s*(?:,?\s*(?:usa|us|united states))?\.?\s*$/i.exec(text);
  return trailing && !/\bbox\s*$/i.test(text.slice(0, trailing.index)) ? trailing[1] : null;
}

function haversineMiles([lat1,lon1],[lat2,lon2]) {
  const rad = degrees => degrees * Math.PI / 180, dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Pure, keyless estimate: centroid distance x road factor at the average
 * speed plus fixed overhead, rounded up to 5 minutes. Unknown ZIP => null. */
export function offlineTravelEstimate(fromAddress, toAddress) {
  const fromZip = addressZip(fromAddress), toZip = addressZip(toAddress);
  const from = TRAVEL_ZIP_CENTROIDS[fromZip], to = TRAVEL_ZIP_CENTROIDS[toZip];
  if (!from || !to) return null;
  const miles = haversineMiles(from, to) * TRAVEL_ROAD_FACTOR;
  return { minutes: roundUp(miles / TRAVEL_AVERAGE_MPH * 60 + TRAVEL_OVERHEAD_MINUTES), miles: Math.round(miles * 10) / 10, source: 'offline_zip', fromZip, toZip };
}

export function travelSettings(env = {}) {
  const raw = String(env?.EGC_DISPATCH_TRAVEL_ESTIMATES ?? '').trim().toLowerCase(), requestedMode = MODES.has(raw) ? raw : 'off';
  const keyed = typeof env?.GOOGLE_MAPS_SERVER_API_KEY === 'string' && env.GOOGLE_MAPS_SERVER_API_KEY.trim() !== '';
  return { requestedMode, mode: requestedMode === 'google' && !keyed ? 'offline' : requestedMode, blockShort: String(env?.EGC_DISPATCH_BLOCK_TRAVEL_SHORT ?? '').trim().toLowerCase() === 'true' };
}

const place = value => typeof value === 'string' ? { address: value, propertyId: '' } : { address: typeof value?.address === 'string' ? value.address : '', propertyId: typeof value?.propertyId === 'string' ? value.propertyId.trim() : '' };
const pairKey = (a, b) => JSON.stringify([a.propertyId, normalizeAddress(a.address), b.propertyId, normalizeAddress(b.address)]);
const samePlace = (a, b) => sameOperationalProperty(a, b) || Boolean(normalizeAddress(a.address)) && normalizeAddress(a.address) === normalizeAddress(b.address);

/** Request-scoped estimator. `fetcher(url, init)` is only used in google mode;
 * `store` ({readMany, commit}) only holds the google cache. Google work per
 * request is bounded: each prefetch makes at most one batched cache read (the
 * first CACHE_READ_LIMIT routes; later routes resolve offline without touching
 * Firestore) and one batched cache commit (skipped when `cacheWrites` is false),
 * and the estimator makes at most `googleLimit` Distance Matrix calls. The first
 * provider-level failure (REQUEST_DENIED, quota, outage) stops Google for the
 * rest of the request. */
export function travelEstimator({ env = {}, fetcher = (url, init) => fetch(url, init), store = null, now = () => new Date(), googleLimit = GOOGLE_PAIR_LIMIT, cacheWrites = true } = {}) {
  const settings = travelSettings(env), key = settings.mode === 'google' ? env.GOOGLE_MAPS_SERVER_API_KEY.trim() : '', memo = new Map();
  const cache = typeof store?.readMany === 'function' && typeof store?.commit === 'function' ? store : null, limit = Number.isInteger(googleLimit) ? Math.min(GOOGLE_PAIR_LIMIT, Math.max(0, googleLimit)) : GOOGLE_PAIR_LIMIT;
  let googleCalls = 0, googleStopped = false;
  async function drive(a, b) {
    if (googleStopped || googleCalls >= limit) return null;
    googleCalls++;
    try {
      const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json');
      for (const [name, value] of [['origins', a.address.trim()], ['destinations', b.address.trim()], ['mode', 'driving'], ['units', 'imperial'], ['key', key]]) url.searchParams.set(name, value);
      const response = await fetcher(url.toString(), { method: 'GET', signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS) });
      const body = response?.ok ? await response.json() : null;
      if (body?.status !== 'OK') { googleStopped = true; return null; }
      const element = body.rows?.[0]?.elements?.[0], seconds = element?.status === 'OK' ? element.duration?.value : NaN;
      return Number.isFinite(seconds) && seconds >= 0 && seconds <= 86400 ? roundUp(seconds / 60) : null;
    } catch { googleStopped = true; return null; }
  }
  async function googleBatch(entries) {
    const found = new Map(), routes = new Map(), writes = [], at = new Date(now()).getTime();
    for (const { id, a, b } of entries) {
      const from = normalizeAddress(a.address), to = normalizeAddress(b.address);
      if (!from || !to) continue;
      const cacheId = await hex(`${from}|${to}`);
      if (!routes.has(cacheId) && routes.size < CACHE_READ_LIMIT) routes.set(cacheId, { a, b, ids: [] });
      routes.get(cacheId)?.ids.push(id);
    }
    if (!routes.size) return found;
    const rows = cache ? await cache.readMany('dispatchTravelCache', [...routes.keys()]).catch(() => []) : [];
    const cached = new Map((Array.isArray(rows) ? rows : []).filter(row => routes.has(row?.id)).map(row => [row.id, row])), misses = [];
    for (const [cacheId, route] of routes) {
      const row = cached.get(cacheId);
      if (row && Number.isInteger(row.minutes) && row.minutes >= 0 && new Date(row.expiresAt).getTime() > at) for (const id of route.ids) found.set(id, { minutes: row.minutes, source: 'google', cached: true });
      else misses.push({ cacheId, route, revision: row?.revision });
    }
    const lookup = async ({ cacheId, route, revision }) => {
      const minutes = await drive(route.a, route.b);
      if (minutes === null) return;
      for (const id of route.ids) found.set(id, { minutes, source: 'google' });
      writes.push({ collection: 'dispatchTravelCache', id: cacheId, revision, patch: { minutes, source: 'google', fetchedAt: new Date(at).toISOString(), expiresAt: new Date(at + CACHE_TTL_MS) } });
    };
    // One probe call proves the key before the rest run a few at a time.
    if (misses.length) await lookup(misses[0]);
    let next = 1;
    await Promise.all(Array.from({ length: Math.max(0, Math.min(GOOGLE_CONCURRENCY, misses.length - 1)) }, async () => { while (next < misses.length) await lookup(misses[next++]); }));
    if (cache && cacheWrites && writes.length) await cache.commit(writes).catch(() => null);
    return found;
  }
  /** Resolve every pair up front so schedule checks stay synchronous. */
  async function prefetch(pairs) {
    const google = new Map();
    for (const [from, to] of pairs) {
      const a = place(from), b = place(to), id = pairKey(a, b);
      if (memo.has(id) || google.has(id)) continue;
      if (settings.mode === 'off' || !a.address.trim() && !a.propertyId || !b.address.trim() && !b.propertyId) memo.set(id, Promise.resolve(null));
      else if (samePlace(a, b)) memo.set(id, Promise.resolve({ minutes: 0, source: 'same_property' }));
      else if (settings.mode === 'google') google.set(id, { id, a, b });
      else memo.set(id, Promise.resolve(offlineTravelEstimate(a.address, b.address)));
    }
    if (google.size) {
      const batch = googleBatch([...google.values()]).catch(() => new Map());
      for (const { id, a, b } of google.values()) memo.set(id, batch.then(found => found.get(id) || offlineTravelEstimate(a.address, b.address)));
    }
    const found = new Map();
    for (const [from, to] of pairs) { const id = pairKey(place(from), place(to)); found.set(id, await memo.get(id)); }
    return (from, to) => found.get(pairKey(place(from), place(to))) ?? null;
  }
  const estimate = async (from, to) => (await prefetch([[from, to]]))(from, to);
  return { ...settings, enabled: settings.mode !== 'off', windowMinutes: TRAVEL_WINDOW_MINUTES, estimate, prefetch };
}

function routeQuery(query, now) {
  if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !['date','employeeId'].includes(key))) throw fail('dispatch_travel_invalid', 'The drive-time request contains unsupported fields.');
  const date = query.date || denverToday(now);
  if (!validDate(date)) throw fail('dispatch_travel_invalid', 'Choose a valid route date.');
  if (query.employeeId !== undefined && (typeof query.employeeId !== 'string' || !query.employeeId.trim() || query.employeeId.length > 180)) throw fail('dispatch_travel_invalid', 'Choose a valid employee.');
  return { date, employeeId: query.employeeId ? query.employeeId.trim().toLowerCase() : null };
}

/** Read-only per-employee day routes. No mutation; google mode may write cache. */
export async function dispatchTravelRoutes(store, session, query = {}, now = new Date(), { travel = null, authorize = requireDispatcher } = {}) {
  authorize(session);
  const input = routeQuery(query, now), estimator = travel || travelEstimator();
  const [jobs, roster, rules] = await Promise.all([jobsForWindow(store, dayWindow(input.date), 'routes'), store.roster(), dispatchRuleSettings(store)]);
  if (input.employeeId && !roster.some(person => person.id === input.employeeId)) throw fail('dispatch_employee_inactive', 'That employee is not in the active roster. Refresh the roster.');
  const routes = new Map(), warnings = [];
  const route = id => {
    if (!routes.has(id)) { const person = roster.find(row => row.id === id); routes.set(id, { employeeId: id, name: person?.name || id, active: Boolean(person), complete: true, stops: [] }); }
    return routes.get(id);
  };
  // A split job is one stop per segment, on that segment's crew routes only.
  for (const job of jobs.filter(stop).flatMap(jobSegments)) {
    const crew = scheduleCrewIds(job, roster).filter(id => !input.employeeId || id === input.employeeId), interval = scheduleInterval(job);
    if (!crew.length) continue;
    if (!interval) {
      const endDate = job.endDate || job.date;
      if (job.date && (!validDate(job.date) || !validDate(endDate) || endDate < job.date || job.date <= input.date && endDate >= input.date)) {
        for (const id of crew) route(id).complete = false;
        if (warnings.length < 100) warnings.push({ code: 'invalid_schedule', jobId: job.id, employeeIds: crew, message: 'An assignment has invalid dates or times. Repair it before relying on this route.' });
      }
      continue;
    }
    if (occupiedDays(job).includes(input.date)) for (const id of crew) route(id).stops.push({ job, interval });
  }
  const legs = [];
  for (const row of routes.values()) {
    row.stops.sort((a, b) => a.interval.start - b.interval.start || a.interval.end - b.interval.end || a.job.id.localeCompare(b.job.id));
    row.legs = row.stops.slice(1).map((next, index) => ({ from: row.stops[index], to: next }));
    legs.push(...row.legs.filter(leg => leg.from.interval.end <= leg.to.interval.start));
  }
  const lookup = await estimator.prefetch(legs.map(leg => [leg.from.job, leg.to.job]));
  let unestimated = 0;
  const employees = [...routes.values()].filter(row => row.stops.length || !row.complete).sort((a, b) => a.name.localeCompare(b.name) || a.employeeId.localeCompare(b.employeeId)).map(row => {
    const output = row.legs.map(({ from, to }) => {
      const gap = Math.round((to.interval.start - from.interval.end) / 60000), buffer = Math.max(Number(from.job.travelBufferMinutes) || 0, Number(to.job.travelBufferMinutes) || 0);
      const base = { fromJobId: from.job.id, toJobId: to.job.id, gapMinutes: gap, bufferMinutes: buffer };
      if (gap < 0) return { ...base, estimatedMinutes: null, estimateSource: null, requiredMinutes: buffer, shortByMinutes: Math.round((Math.min(from.interval.end, to.interval.end) - to.interval.start) / 60000), status: 'overlap' };
      // Same rule as the board: an identical address never needs a drive, in every mode.
      const found = lookup(from.job, to.job), required = Math.max(buffer, found?.minutes || 0), sameAddress = Boolean(assignmentKey(from.job.address)) && assignmentKey(from.job.address) === assignmentKey(to.job.address);
      if (found?.source === 'same_property' || sameAddress) return { ...base, estimatedMinutes: 0, estimateSource: 'same_property', requiredMinutes: buffer, shortByMinutes: 0, status: 'same_property' };
      if (estimator.enabled && !found) unestimated++;
      return { ...base, estimatedMinutes: found ? found.minutes : null, estimateSource: found?.source || null, requiredMinutes: required, shortByMinutes: Math.max(0, required - gap), status: gap < required ? 'short' : 'ok' };
    });
    return { employeeId: row.employeeId, name: row.name, active: row.active, complete: row.complete,
      jobs: row.stops.map(({ job, interval }) => ({ id: job.id, type: job.type, customer: job.customer || '', title: job.title || '', address: job.address || '', date: interval.date, time: interval.time, endDate: interval.endDate, endTime: interval.endTime, startAt: interval.startAt, endAt: interval.endAt, status: job.pipelineStatus || job.status || 'scheduled', travelBufferMinutes: Number(job.travelBufferMinutes) || 0 })),
      legs: output, totals: { stops: row.stops.length, legs: output.length, shortLegs: output.filter(leg => ['short','overlap'].includes(leg.status)).length, estimatedDriveMinutes: output.reduce((sum, leg) => sum + (leg.estimatedMinutes || 0), 0), unestimatedLegs: output.filter(leg => leg.estimateSource === null && leg.status !== 'overlap').length } };
  });
  if (!estimator.enabled) warnings.unshift({ code: 'travel_estimates_disabled', message: 'Drive-time estimates are turned off. Legs compare each gap with the manual travel buffer only.' });
  else {
    if (estimator.requestedMode === 'google' && estimator.mode !== 'google') warnings.unshift({ code: 'travel_google_key_missing', message: 'Google drive times are selected but no server key is configured. Built-in ZIP estimates are used instead.' });
    if (unestimated) warnings.push({ code: 'travel_estimate_unavailable', count: unestimated, message: `${unestimated} ${unestimated === 1 ? 'leg has' : 'legs have'} no drive estimate (unknown ZIP or address). The manual travel buffer applies.` });
  }
  return { ok: true, timeZone: DISPATCH_TIME_ZONE, date: input.date, asOf: now.toISOString(), travel: { mode: estimator.mode, requestedMode: estimator.requestedMode, blockTravelShort: estimator.enabled && (estimator.blockShort || rules.blockTravelShort) }, coverage: { complete: true, asOf: now.toISOString() }, employees, warnings };
}
