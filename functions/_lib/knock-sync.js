// Applies a rep's queued canvassing events. Events are append-only (knock_events, create-only by the
// phone's UUID, so a replayed batch is acknowledged without a second write). Shifts, house summaries
// and day summaries are then rebuilt from the events, so a retry after any failure heals them.
import { knockFailure, write } from './knock-store.js';
import { shiftEligibility } from './knock-access.js';
import { houseInScope, neighborhoodLock, phoneHouse, publicShift, repTerritory } from './knock-territory.js';
import { applySaleEvent, validateSaleEvent } from './knock-sales.js';
import { OUTCOMES } from '../../crew/knock-settings.js';
import { knockWindow, zonedDate } from '../../crew/knock-time.js';
import { effectiveKnocks, summarizeHouse } from '../../crew/knock-doors.js';
import { daySummary, deriveShift, shiftTiming } from '../../crew/knock-stats.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const HOUSE_ID = /^[A-Za-z0-9_.-]{1,150}$/;
const TYPES = new Set(['shift.start', 'shift.break_start', 'shift.break_end', 'shift.end', 'knock', 'knock.void', 'knock.edit', 'sale']);
const MAX_FUTURE_MS = 10 * 60000;
const MAX_AGE_MS = 14 * 86400000;
export const MAX_BATCH = 40;

const refuse = (code, error) => ({ status: 'rejected', code, error });

async function fingerprint(event) {
  const canonical = JSON.stringify(Object.keys(event).sort().reduce((out, key) => ({ ...out, [key]: event[key] }), {}));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Shape checks that need no stored data. Returns a rejection or null.
function shapeProblem(event, nowMs) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return refuse('knock_event_invalid', 'Unreadable change.');
  if (!UUID.test(String(event.id || ''))) return refuse('knock_event_invalid', 'Missing change id.');
  if (!TYPES.has(event.type)) return refuse('knock_event_type', 'Unknown kind of change.');
  if (!ISO.test(String(event.at || ''))) return refuse('knock_event_time', 'Missing time.');
  const at = Date.parse(event.at);
  if (at - nowMs > MAX_FUTURE_MS) return refuse('knock_event_future', 'This phone\'s clock is ahead. Fix the date and time, then sync.');
  if (nowMs - at > MAX_AGE_MS) return refuse('knock_event_too_old', 'This change is more than 14 days old and cannot be synced. Tell an admin.');
  if (event.type.startsWith('shift.') || event.type === 'knock') {
    if (!UUID.test(String(event.shiftId || ''))) return refuse('knock_event_invalid', 'Missing shift.');
  }
  if (['knock', 'knock.void', 'knock.edit'].includes(event.type) && !HOUSE_ID.test(String(event.houseId || ''))) return refuse('knock_event_invalid', 'Missing house.');
  if (['knock.void', 'knock.edit'].includes(event.type) && !UUID.test(String(event.target || ''))) return refuse('knock_event_invalid', 'Missing the door being changed.');
  if (event.type === 'knock' || event.type === 'knock.edit') {
    if (!OUTCOMES.includes(event.outcome)) return refuse('knock_outcome_invalid', 'Unknown door outcome.');
    if (event.type === 'knock.edit' && event.outcome === 'sold') return refuse('knock_edit_sold', 'Log a sale from the Sold button so the checklist is captured.');
    if (event.carOutside != null && typeof event.carOutside !== 'boolean') return refuse('knock_event_invalid', 'Car outside must be yes or no.');
    if (event.quotedAmount != null && !(Number.isFinite(Number(event.quotedAmount)) && Number(event.quotedAmount) >= 0 && Number(event.quotedAmount) <= 100000)) return refuse('knock_quote_invalid', 'Quoted amount must be $0 to $100,000.');
    if (event.comeBackAt != null && (event.outcome !== 'come_back' || !ISO.test(String(event.comeBackAt)))) return refuse('knock_event_invalid', 'Come-back time is only for Come back.');
    if (event.note != null && String(event.note).length > 500) return refuse('knock_event_invalid', 'Note is too long.');
  }
  return null;
}

// The stored form of an event: client fields kept, identity and server facts added. A sale event
// keeps only its link to the door; the customer's details live on the knock_sales record alone.
function storedEvent(event, rep, extra) {
  const keep = event.type === 'sale' ? ['type', 'houseId', 'at', 'knockId']
    : ['type', 'shiftId', 'houseId', 'outcome', 'carOutside', 'quotedAmount', 'comeBackAt', 'note', 'at', 'target', 'cityKey', 'afterEnd', 'reason', 'lat', 'lng', 'accuracy'];
  const stored = { repKey: rep.repKey };
  for (const key of keep) if (event[key] !== undefined) stored[key] = event[key];
  if (stored.quotedAmount != null) stored.quotedAmount = Math.round(Number(stored.quotedAmount) * 100) / 100;
  for (const key of ['lat', 'lng', 'accuracy']) if (stored[key] != null && !Number.isFinite(Number(stored[key]))) delete stored[key];
  return { ...stored, ...extra };
}

async function eventsWhere(store, field, value) {
  return store.query('knock_events', { where: [[field, '==', value]] });
}

/* Process one batch for a signed-in, active rep. Returns { results, houses, shift }. */
export async function applyBatch(store, rep, settings, events, nowMs) {
  if (!Array.isArray(events) || !events.length) throw knockFailure('Nothing to sync.', 400, 'knock_nothing_to_sync');
  if (events.length > MAX_BATCH) throw knockFailure(`Sync at most ${MAX_BATCH} changes at a time.`, 413, 'knock_batch_too_large');
  const nowIso = new Date(nowMs).toISOString();
  const results = new Map();
  const valid = [];
  const seen = new Set();
  for (const event of events) {
    const problem = shapeProblem(event, nowMs);
    const id = String(event?.id || '');
    if (problem) { if (id) results.set(id, problem); continue; }
    if (seen.has(id)) continue;
    seen.add(id);
    valid.push(event);
  }

  // Replays: an event already stored with the same content is acknowledged as a duplicate.
  const existing = valid.length ? await store.getMany('knock_events', valid.map(e => e.id)) : new Map();
  const fresh = [];
  for (const event of valid) {
    const fp = await fingerprint(event);
    const stored = existing.get(event.id);
    if (!stored) { fresh.push({ event, fp }); continue; }
    results.set(event.id, stored.fingerprint === fp && stored.repKey === rep.repKey ? { status: 'duplicate' } : refuse('knock_event_conflict', 'A different change already used this id.'));
  }

  // Context for validation.
  const territory = await repTerritory(store, rep, settings);
  const neighborhoods = new Map(territory.neighborhoods.map(n => [n.id, n]));
  const houseIds = new Set(valid.filter(e => e.houseId).map(e => e.houseId));
  const houses = houseIds.size ? await store.getMany('knock_houses', [...houseIds]) : new Map();
  const shiftIds = new Set(valid.filter(e => e.shiftId).map(e => e.shiftId));
  const shiftEvents = new Map();
  for (const shiftId of shiftIds) shiftEvents.set(shiftId, await eventsWhere(store, 'shiftId', shiftId));
  const targetIds = valid.filter(e => e.target).map(e => e.target);
  const targets = targetIds.length ? await store.getMany('knock_events', targetIds) : new Map();
  const accepted = [];
  const touchedHouses = new Set(), touchedShifts = new Set(), touchedDays = new Set();

  for (const { event, fp } of fresh) {
    const at = Date.parse(event.at);
    const flags = [];
    const priorShift = event.shiftId ? deriveShift([...(shiftEvents.get(event.shiftId) || []), ...accepted.filter(a => a.shiftId === event.shiftId)], event.shiftId) : null;
    let extra = {};

    if (event.type === 'shift.start') {
      if (priorShift) { results.set(event.id, refuse('knock_shift_exists', 'That shift already started.')); continue; }
      const eligible = shiftEligibility(rep);
      if (!eligible.ok) { results.set(event.id, refuse('knock_shift_not_allowed', eligible.reason)); continue; }
      const cityKey = settings.cities[event.cityKey] ? event.cityKey : Object.keys(settings.cities)[0];
      const window = knockWindow(settings.cities[cityKey], at);
      if (window.phase !== 'open') flags.push('outside_hours');
      extra = { cityKey, day: zonedDate(at, settings.cities[cityKey].timeZone), flags };
      // One shift at a time: a shift still open on the server ends at its last door.
      for (const open of await store.query('knock_shifts', { where: [['repKey', '==', rep.repKey], ['endedAt', '==', null]] })) {
        if (open.id === event.shiftId || accepted.some(a => a.type === 'shift.end' && a.shiftId === open.id)) continue;
        const endAt = open.lastDoorAt && open.lastDoorAt < event.at ? open.lastDoorAt : (open.startedAt < event.at ? open.startedAt : event.at);
        accepted.push({ id: crypto.randomUUID(), type: 'shift.end', reason: 'replaced', shiftId: open.id, repKey: rep.repKey, at: endAt, day: open.day, receivedAt: nowIso, fingerprint: 'server' });
        touchedShifts.add(open.id);
      }
    } else if (event.type.startsWith('shift.')) {
      if (!priorShift || priorShift.repKey !== rep.repKey) { results.set(event.id, refuse('knock_shift_missing', 'That shift was not found.')); continue; }
      if (priorShift.endedAt && event.type !== 'shift.end') { results.set(event.id, refuse('knock_shift_ended', 'That shift already ended.')); continue; }
      extra = { day: priorShift.day };
    } else if (event.type === 'knock') {
      if (!priorShift || priorShift.repKey !== rep.repKey) { results.set(event.id, refuse('knock_shift_missing', 'Start a shift before logging doors.')); continue; }
      if (at < Date.parse(priorShift.startedAt) - 60000) { results.set(event.id, refuse('knock_before_shift', 'That door is from before the shift started.')); continue; }
      if (priorShift.endedAt && priorShift.endReason !== 'idle' && at > Date.parse(priorShift.endedAt) + 60000) { results.set(event.id, refuse('knock_shift_ended', 'That shift already ended. Start a new shift.')); continue; }
      const house = houses.get(event.houseId);
      if (!house) { results.set(event.id, refuse('knock_house_missing', 'That house is not in canvassing.')); continue; }
      const nbhd = neighborhoods.get(house.neighborhoodId);
      if (!nbhd || !houseInScope(house, territory)) { results.set(event.id, refuse('knock_not_assigned', 'That house is not in your assigned territory.')); continue; }
      const lock = neighborhoodLock({ ...nbhd, status: nbhd.status, holdReason: nbhd.holdReason }, rep, settings);
      if (lock.locked) { results.set(event.id, refuse('knock_locked', lock.reason)); continue; }
      const city = settings.cities[nbhd.cityKey];
      const window = knockWindow(city, at);
      if (window.phase === 'grace') flags.push('after_sunset');
      else if (window.phase !== 'open') flags.push('outside_hours');
      if (house.noKnock?.source === 'city') flags.push('no_knock_list');
      if (house.excluded) flags.push('excluded_house');
      extra = { neighborhoodId: house.neighborhoodId, street: house.street, day: zonedDate(at, city.timeZone), flags };
    } else if (event.type === 'knock.void' || event.type === 'knock.edit') {
      const target = targets.get(event.target) || accepted.find(a => a.id === event.target);
      if (!target || target.type !== 'knock' || target.repKey !== rep.repKey || target.houseId !== event.houseId) { results.set(event.id, refuse('knock_target_missing', 'That door was not found.')); continue; }
      if (target.outcome === 'sold') {
        const sale = await store.query('knock_sales', { where: [['knockId', '==', target.id]], limit: 1 });
        if (sale.length || accepted.some(a => a.type === 'sale' && a.knockId === target.id)) { results.set(event.id, refuse('knock_sold_locked', 'A sale was saved for this door. Ask an admin to cancel the sale instead.')); continue; }
      }
      // The change joins the door's shift so the shift's door count is rebuilt with it.
      extra = { shiftId: target.shiftId, neighborhoodId: target.neighborhoodId, street: target.street, day: zonedDate(at, 'America/Denver'), targetDay: target.day };
    } else if (event.type === 'sale') {
      const problem = await validateSaleEvent(store, rep, settings, event, { accepted, targets, houses, nowMs });
      if (problem) { results.set(event.id, problem); continue; }
      extra = { day: zonedDate(at, 'America/Denver') };
    }

    const stored = { ...storedEvent(event, rep, extra), id: event.id, receivedAt: nowIso, fingerprint: fp };
    accepted.push(stored);
    results.set(event.id, { status: 'applied', ...(flags.length ? { flags } : {}) });
    if (stored.houseId) touchedHouses.add(stored.houseId);
    if (stored.shiftId) touchedShifts.add(stored.shiftId);
    if (stored.day) touchedDays.add(stored.day);
    if (stored.targetDay) touchedDays.add(stored.targetDay);
  }

  // 1. The events themselves (append-only) and any sale records, in one commit.
  if (accepted.length) {
    const writes = accepted.map(({ id, ...data }) => write.create('knock_events', id, data));
    const originals = new Map(fresh.map(({ event }) => [event.id, event]));
    for (const event of accepted.filter(e => e.type === 'sale')) writes.push(...await applySaleEvent(store, rep, settings, originals.get(event.id), nowIso, { houses }));
    try {
      await store.commit(writes);
    } catch (error) {
      if (error.code !== 'knock_exists') throw error;
      // A concurrent replay stored some of these first; ask the phone to send the batch again.
      throw knockFailure('Some changes were saved by another sync at the same moment. Syncing again.', 409, 'knock_retry');
    }
  }
  // Replayed events still rebuild their derived records, which heals a partial earlier sync.
  for (const event of valid) {
    const stored = existing.get(event.id);
    if (!stored || stored.repKey !== rep.repKey) continue;
    if (stored.houseId) touchedHouses.add(stored.houseId);
    if (stored.shiftId) touchedShifts.add(stored.shiftId);
    if (stored.day) touchedDays.add(stored.day);
  }

  // 2. Shifts, rebuilt from their events.
  for (const shiftId of touchedShifts) await rebuildShift(store, shiftId, settings, nowMs);
  // 3. House summaries, rebuilt from every rep's events on the house.
  const updated = [];
  for (const houseId of touchedHouses) {
    const house = await rebuildHouse(store, houseId, settings, nowIso, nowMs);
    if (house) updated.push(phoneHouse(house, rep.repKey));
  }
  // 4. The rep's day summaries.
  for (const day of touchedDays) await rebuildDay(store, rep.repKey, day, settings, nowMs);

  const ordered = events.map(e => ({ id: String(e?.id || ''), ...(results.get(String(e?.id || '')) || refuse('knock_event_invalid', 'Unreadable change.')) }));
  return { results: ordered, houses: updated, shift: await openShiftFor(store, rep.repKey, settings, nowMs) };
}

export async function rebuildShift(store, shiftId, settings, nowMs) {
  const events = await eventsWhere(store, 'shiftId', shiftId);
  const shift = deriveShift(events, shiftId);
  if (!shift) return null;
  const timing = shiftTiming(shift, nowMs, settings.shift.idleAutoEndHours);
  if (timing?.autoEnded && !shift.endedAt) { shift.endedAt = new Date(timing.endAt).toISOString(); shift.endReason = 'idle'; }
  const doc = { ...shift, updatedAt: new Date(nowMs).toISOString() };
  await store.commit([write.set('knock_shifts', shiftId, doc)]);
  return { id: shiftId, ...doc };
}

/* Rebuild one house's outcome summary from every rep's events. Guarded by the house's revision so
   two syncs on the same house cannot leave an older summary on top; the loser re-reads and retries. */
export async function rebuildHouse(store, houseId, settings, nowIso, nowMs) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const house = await store.get('knock_houses', houseId);
    if (!house) return null;
    const events = await eventsWhere(store, 'houseId', houseId);
    const summary = summarizeHouse(events, { seasonStart: settings.goBacks.seasonStart, now: nowMs });
    const patch = { summary, updatedAt: nowIso };
    // A rep's "no-soliciting sign" stays until that knock is voided; the City list is admin-managed.
    if (summary.signFlagged && house.noKnock?.source !== 'city') {
      const sign = effectiveKnocks(events).filter(k => k.outcome === 'skipped_sign').at(-1);
      patch.noKnock = { source: 'sign', at: sign?.at || nowIso, by: sign?.repKey || '' };
    } else if (!summary.signFlagged && house.noKnock?.source === 'sign') {
      patch.noKnock = null;
    }
    try {
      await store.commit([write.patch('knock_houses', houseId, patch, house.__updateTime)]);
      return { ...house, ...patch };
    } catch (error) {
      if (error.code !== 'knock_conflict') throw error;
    }
  }
  throw knockFailure('That house is busy. Syncing again.', 409, 'knock_retry');
}

export async function rebuildDay(store, repKey, day, settings, nowMs) {
  const [dayEvents, lateChanges, shifts, sales] = await Promise.all([
    store.query('knock_events', { where: [['repKey', '==', repKey], ['day', '==', day]] }),
    store.query('knock_events', { where: [['repKey', '==', repKey], ['targetDay', '==', day]] }),
    store.query('knock_shifts', { where: [['repKey', '==', repKey], ['day', '==', day]] }),
    store.query('knock_sales', { where: [['repKey', '==', repKey], ['saleDate', '==', day]] }),
  ]);
  const all = [...dayEvents, ...lateChanges.filter(e => !dayEvents.some(d => d.id === e.id))];
  const knocks = effectiveKnocks(all).filter(k => k.day === day);
  const summary = daySummary({ repKey, date: day, shifts, knocks, sales, now: nowMs, idleAutoEndHours: settings.shift.idleAutoEndHours });
  const flagged = knocks.filter(k => (k.flags || []).length).length;
  await store.commit([write.set('knock_days', `${repKey}_${day}`, { ...summary, flaggedDoors: flagged, updatedAt: new Date(nowMs).toISOString() })]);
  return summary;
}

export async function openShiftFor(store, repKey, settings, nowMs) {
  const rows = await store.query('knock_shifts', { where: [['repKey', '==', repKey], ['endedAt', '==', null]] });
  const open = rows.map(row => ({ row, timing: shiftTiming(row, nowMs, settings.shift.idleAutoEndHours) })).filter(x => x.timing && !x.timing.ended)
    .sort((a, b) => String(b.row.startedAt).localeCompare(String(a.row.startedAt)))[0];
  return open ? publicShift(open.row, settings, nowMs) : null;
}
