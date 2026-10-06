/* Door outcomes and per-house state, shared by the knock page and the server.
   Knocks are append-only. Undo appends a void; an edit appends a replacement of the knock's
   fields. A house's state is always derived from its effective knocks, never edited in place. */
import { zonedParts, zonedDate } from './knock-time.js';

export const ANSWERED = new Set(['not_interested', 'come_back', 'look', 'sold']);
export const LOOKED = new Set(['look', 'sold']);
export const GO_BACK = new Set(['no_answer', 'come_back']);
export const isDoor = outcome => outcome !== 'skipped_sign';

export const OUTCOME_COLORS = Object.freeze({
  none: '#ffffff',
  no_answer: '#f59e0b',
  come_back: '#2563eb',
  not_interested: '#6b7280',
  look: '#7c3aed',
  sold: '#16a34a',
  skipped_sign: '#dc2626',
  blocked: '#dc2626',
});

const EDIT_FIELDS = ['outcome', 'carOutside', 'quotedAmount', 'comeBackAt', 'note'];

const byTime = (a, b) => (Date.parse(a.at) - Date.parse(b.at)) || String(a.id).localeCompare(String(b.id));

/* events: knock / knock.void / knock.edit records for ONE house, in any order.
   Returns the effective knocks oldest first, each with edits applied. */
export function effectiveKnocks(events) {
  const list = Array.isArray(events) ? events : [];
  const voided = new Set(list.filter(e => e?.type === 'knock.void' && e.target).map(e => e.target));
  const latestEdit = new Map();
  for (const edit of list.filter(e => e?.type === 'knock.edit' && e.target && !voided.has(e.id)).sort(byTime)) {
    latestEdit.set(edit.target, edit);
  }
  return list
    .filter(e => e?.type === 'knock' && !voided.has(e.id))
    .map(knock => {
      const edit = latestEdit.get(knock.id);
      if (!edit) return knock;
      const merged = { ...knock, editedAt: edit.at, editId: edit.id };
      for (const field of EDIT_FIELDS) if (field in edit) merged[field] = edit[field];
      return merged;
    })
    .sort(byTime);
}

export function seasonKey(at, seasonStart = '01-01', timeZone = 'America/Denver') {
  const date = zonedDate(at, timeZone);
  if (!date) return '';
  const year = Number(date.slice(0, 4));
  return date.slice(5) >= seasonStart ? String(year) : String(year - 1);
}

/* The summary stored on each house (server) and cached on the phone. */
export function summarizeHouse(knocks, { seasonStart = '01-01', timeZone = 'America/Denver', now = Date.now() } = {}) {
  const effective = effectiveKnocks(knocks);
  const season = seasonKey(now, seasonStart, timeZone);
  const summary = {
    lastOutcome: null, lastAt: null, lastRepId: null, lastKnockId: null,
    seasonKey: season, seasonAttempts: 0, attempts: 0,
    comeBackAt: null, quotedAmount: null, looks: 0, sold: false,
    signFlagged: false, carOutside: null, knockCount: effective.length,
  };
  for (const knock of effective) {
    if (isDoor(knock.outcome)) {
      summary.attempts += 1;
      if (seasonKey(knock.at, seasonStart, timeZone) === season) summary.seasonAttempts += 1;
    }
    if (LOOKED.has(knock.outcome)) summary.looks += 1;
    if (knock.outcome === 'sold') summary.sold = true;
    if (knock.outcome === 'skipped_sign') summary.signFlagged = true;
    if (knock.quotedAmount != null) summary.quotedAmount = knock.quotedAmount;
    summary.lastOutcome = knock.outcome;
    summary.lastAt = knock.at;
    summary.lastRepId = knock.repId || null;
    summary.lastKnockId = knock.id;
    summary.comeBackAt = knock.outcome === 'come_back' ? (knock.comeBackAt || null) : null;
    summary.carOutside = typeof knock.carOutside === 'boolean' ? knock.carOutside : null;
  }
  return summary;
}

// Apply one not-yet-synced knock on top of a server summary (the phone's optimistic view).
export function applyLocalKnock(summary, knock, { seasonStart = '01-01', timeZone = 'America/Denver', now = Date.now() } = {}) {
  const next = { ...(summary || summarizeHouse([], { seasonStart, timeZone, now })) };
  const season = seasonKey(now, seasonStart, timeZone);
  if (next.seasonKey !== season) { next.seasonKey = season; next.seasonAttempts = 0; }
  if (isDoor(knock.outcome)) {
    next.attempts = (next.attempts || 0) + 1;
    if (seasonKey(knock.at, seasonStart, timeZone) === season) next.seasonAttempts += 1;
  }
  if (LOOKED.has(knock.outcome)) next.looks = (next.looks || 0) + 1;
  if (knock.outcome === 'sold') next.sold = true;
  if (knock.outcome === 'skipped_sign') next.signFlagged = true;
  if (knock.quotedAmount != null) next.quotedAmount = knock.quotedAmount;
  next.lastOutcome = knock.outcome;
  next.lastAt = knock.at;
  next.lastRepId = knock.repId || null;
  next.lastKnockId = knock.id;
  next.comeBackAt = knock.outcome === 'come_back' ? (knock.comeBackAt || null) : null;
  next.carOutside = typeof knock.carOutside === 'boolean' ? knock.carOutside : null;
  next.knockCount = (next.knockCount || 0) + 1;
  return next;
}

function addMonths(ms, months) {
  const d = new Date(ms);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return target.getTime();
}

export function timeBucket(at, buckets, timeZone = 'America/Denver') {
  const parts = zonedParts(at, timeZone);
  if (!parts) return null;
  const hhmm = `${String(parts.hour).padStart(2, '0')}:${String(parts.minute).padStart(2, '0')}`;
  return (buckets || []).find(b => hhmm >= b.start && hhmm < b.end) || null;
}

/* Why a house can or cannot be knocked right now.
   status: 'new' | 'go_back' | 'rested' (knockable) or
           'blocked' | 'excluded' | 'resting' | 'done' | 'max_attempts' (not knockable) */
export function doorStatus(house, summary, settings, now = Date.now()) {
  const goBacks = settings?.goBacks || {};
  const timeZone = settings?.timeZone || 'America/Denver';
  if (house?.noKnock || summary?.signFlagged) return { knockable: false, status: 'blocked', reason: house?.noKnock?.source === 'city' ? 'On the City no-solicitation list' : 'No-soliciting sign' };
  if (house?.excluded) return { knockable: false, status: 'excluded', reason: 'Excluded by admin (unit, condo or townhome)' };
  if (house?.jurisdictionHold) return { knockable: false, status: 'excluded', reason: 'Outside this neighborhood\'s town rules' };
  if (!summary?.lastOutcome) return { knockable: true, status: 'new', reason: 'Not knocked yet' };
  const outcome = summary.lastOutcome;
  if (outcome === 'sold' || outcome === 'look') return { knockable: false, status: 'done', reason: outcome === 'sold' ? 'Sold' : 'Look done' };
  if (outcome === 'not_interested') {
    const restUntil = addMonths(Date.parse(summary.lastAt), Number(goBacks.notInterestedRestMonths ?? 6));
    return now >= restUntil
      ? { knockable: true, status: 'rested', reason: 'Not interested over the rest period ago' }
      : { knockable: false, status: 'resting', reason: 'Not interested', restUntil };
  }
  if (GO_BACK.has(outcome)) {
    const season = seasonKey(now, goBacks.seasonStart || '01-01', timeZone);
    const attempts = summary.seasonKey === season ? Number(summary.seasonAttempts || 0) : 0;
    const max = Number(goBacks.maxAttemptsPerSeason ?? 3);
    if (attempts >= max) return { knockable: false, status: 'max_attempts', reason: `${attempts} tries this season` };
    return { knockable: true, status: 'go_back', reason: outcome === 'come_back' ? 'Come back' : 'No answer', attemptsLeft: max - attempts };
  }
  return { knockable: true, status: 'new', reason: '' };
}

// Suggest when to go back: the requested come-back time, else a different time of day than the last try.
export function goBackSuggestion(summary, settings) {
  const timeZone = settings?.timeZone || 'America/Denver';
  const buckets = settings?.goBacks?.buckets || [];
  if (summary?.comeBackAt) return { kind: 'requested', at: summary.comeBackAt, label: 'They asked you to come back' };
  const last = timeBucket(summary?.lastAt, buckets, timeZone);
  if (!last || !buckets.length) return { kind: 'any', label: 'Any time' };
  const index = buckets.findIndex(b => b.key === last.key);
  // Rotate two buckets ahead so a morning miss becomes an afternoon, an evening miss a midday.
  const pick = buckets[(index + 2) % buckets.length];
  return { kind: 'bucket', bucket: pick.key, label: `Try ${pick.label.toLowerCase()} (last try: ${last.label.toLowerCase()})` };
}

/* ---- Geography ---- */

export function distanceMeters(a, b) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// The nearest house never knocked; failing that the nearest go-back. houses: [{ house, status }].
export function nearestSuggestion(entries, position) {
  if (!position || !Number.isFinite(position.lat) || !Number.isFinite(position.lng)) return null;
  let best = null;
  for (const tier of ['new', 'go_back', 'rested']) {
    for (const entry of entries) {
      if (entry.status?.status !== tier || !Number.isFinite(entry.house?.lat)) continue;
      const meters = distanceMeters(position, entry.house);
      if (!best || meters < best.meters) best = { ...entry, meters };
    }
    if (best) return best;
  }
  return null;
}

export const houseNumberValue = number => {
  const match = String(number || '').match(/^(\d+)/);
  return match ? Number(match[1]) : NaN;
};

/* After a door on a street, the next knockable house walking the same side in the same
   direction, then crossing over and walking the other side back. */
export function nextOnStreet(entries, current, previousNumber = null) {
  const curNum = houseNumberValue(current?.number);
  const candidates = entries.filter(e => e.house.street === current?.street && e.house.id !== current?.id && e.status?.knockable);
  if (!candidates.length || !Number.isFinite(curNum)) return candidates[0] || null;
  const parity = curNum % 2;
  const upward = previousNumber == null || !Number.isFinite(Number(previousNumber)) ? true : curNum >= Number(previousNumber);
  const value = e => houseNumberValue(e.house.number);
  const sameSide = candidates.filter(e => value(e) % 2 === parity);
  const ahead = sameSide.filter(e => upward ? value(e) > curNum : value(e) < curNum)
    .sort((a, b) => upward ? value(a) - value(b) : value(b) - value(a));
  if (ahead.length) return ahead[0];
  const otherSide = candidates.filter(e => value(e) % 2 !== parity)
    .sort((a, b) => upward ? value(b) - value(a) : value(a) - value(b));
  if (otherSide.length) return otherSide[0];
  const behind = sameSide.sort((a, b) => Math.abs(value(a) - curNum) - Math.abs(value(b) - curNum));
  return behind[0] || null;
}

/* ---- Addresses ---- */

const DIRECTIONS = { NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW' };
const SUFFIXES = {
  STREET: 'ST', AVENUE: 'AVE', AV: 'AVE', DRIVE: 'DR', COURT: 'CT', LANE: 'LN', ROAD: 'RD', PLACE: 'PL',
  CIRCLE: 'CIR', BOULEVARD: 'BLVD', PARKWAY: 'PKWY', TRAIL: 'TRL', TERRACE: 'TER', HIGHWAY: 'HWY',
  WAY: 'WAY', POINT: 'PT', CROSSING: 'XING', SQUARE: 'SQ', LOOP: 'LOOP', COVE: 'CV', RUN: 'RUN', PASS: 'PASS',
};
const UNIT_WORDS = ['UNIT', 'APT', 'APARTMENT', 'STE', 'SUITE', 'BLDG', 'BUILDING', 'LOT', 'SPC', 'SPACE', 'TRLR', 'NO'];
const UNIT_PATTERN = new RegExp(`(?:\\s+(?:${UNIT_WORDS.join('|')})\\.?\\s*|\\s*#\\s*)([A-Z0-9-]+)\\s*$`);

function clean(text) {
  return String(text || '').toUpperCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
}

/* "1234 West Elizabeth Street, Unit 5, Fort Collins, CO 80521" -> { number:'1234', street:'W ELIZABETH ST', unit:'5' }.
   A city/state/zip after the first comma is dropped. */
export function parseAddress(text) {
  const raw = String(text || '').toUpperCase();
  const parts = raw.split(',').map(p => p.trim()).filter(Boolean);
  let line = parts[0] || '';
  // "123 Main St, Apt 4, Fort Collins" keeps the unit that followed the first comma.
  if (parts[1] && new RegExp(`^(?:${UNIT_WORDS.join('|')}|#)`).test(parts[1])) line += ' ' + parts[1];
  line = clean(line).replace(/\s+(CO|COLORADO)\s+\d{5}(?:-\d{4})?$/, '').replace(/\s+\d{5}(?:-\d{4})?$/, '');
  let unit = '';
  const unitMatch = line.match(UNIT_PATTERN);
  if (unitMatch) { unit = unitMatch[1]; line = line.slice(0, unitMatch.index).trim(); }
  const match = line.match(/^(\d+)([A-Z])?(?:\s*-\s*\d+)?\s+(.+)$/);
  if (!match) return null;
  if (match[2] && !unit) unit = match[2];
  const words = match[3].split(' ').map(word => DIRECTIONS[word] || SUFFIXES[word] || word);
  return { number: match[1], street: words.join(' '), unit };
}

export function addressKey(parsed) {
  if (!parsed?.number || !parsed?.street) return '';
  return `${parsed.number} ${parsed.street}${parsed.unit ? ` #${parsed.unit}` : ''}`;
}

export const normalizeAddress = text => addressKey(parseAddress(text));

export function houseLabel(house) {
  return `${house.number} ${titleStreet(house.street)}${house.unit ? ` #${house.unit}` : ''}`;
}

export function titleStreet(street) {
  return String(street || '').split(' ').map(word => /^(N|S|E|W|NE|NW|SE|SW)$/.test(word) ? word : word.charAt(0) + word.slice(1).toLowerCase()).join(' ');
}

/* Match pasted no-solicitation lines to houses. Returns { matched: [{line, houseId}], unmatched: [line] }. */
export function matchNoKnockList(text, houses) {
  const byKey = new Map();
  const byBase = new Map();
  for (const house of houses) {
    const key = addressKey(house);
    if (key) byKey.set(key, house.id);
    const base = `${house.number} ${house.street}`;
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(house.id);
  }
  const matched = [], unmatched = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parsed = parseAddress(line);
    if (!parsed) { unmatched.push(line); continue; }
    const exact = byKey.get(addressKey(parsed));
    if (exact) { matched.push({ line, houseId: exact }); continue; }
    // A listed address without a unit covers every unit at that number.
    const all = !parsed.unit ? byBase.get(`${parsed.number} ${parsed.street}`) : null;
    if (all?.length) all.forEach(houseId => matched.push({ line, houseId }));
    else unmatched.push(line);
  }
  return { matched, unmatched };
}

// Stable house document id from its address, so re-imports update instead of duplicating.
export function houseIdFor(parsed) {
  const key = addressKey(parsed).toLowerCase().replace(/#/g, 'u').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return key ? `h-${key}`.slice(0, 120) : '';
}
