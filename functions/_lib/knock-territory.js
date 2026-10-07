// Territory: neighborhoods, assignments, locks and the houses a rep may see.
// Reps see only what is assigned to them. Premium neighborhoods need a rep cleared for Premium;
// Hold neighborhoods (and any neighborhood whose city has no rule in settings) are locked for all.
import { knockFailure, write } from './knock-store.js';
import { shiftTiming } from '../../crew/knock-stats.js';

export async function loadNeighborhoods(store) {
  const rows = await store.list('knock_neighborhoods');
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

export function neighborhoodLock(nbhd, rep, settings) {
  if (!nbhd) return { locked: true, reason: 'Neighborhood not found' };
  if (nbhd.status === 'hold') return { locked: true, reason: nbhd.holdReason ? `On hold: ${nbhd.holdReason}` : 'On hold' };
  if (!settings?.cities?.[nbhd.cityKey]) return { locked: true, reason: 'No knocking rules set for this town' };
  if (nbhd.tier === 'Premium' && !rep?.premiumCleared && rep?.role !== 'admin') return { locked: true, reason: 'Premium: needs Premium clearance' };
  return { locked: false, reason: '' };
}

export const assignmentId = (repKey, neighborhoodId, street = '') =>
  `${repKey}__${neighborhoodId}__${street ? street.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : 'all'}`.slice(0, 150);

export async function activeAssignments(store, repKey) {
  const rows = await store.query('knock_assignments', { where: [['repKey', '==', repKey], ['active', '==', true]] });
  return rows;
}

/* The rep's territory: each assigned neighborhood with its lock, and which streets (null = all). */
export async function repTerritory(store, rep, settings, neighborhoods = null) {
  const [assignments, all] = await Promise.all([activeAssignments(store, rep.repKey), neighborhoods || loadNeighborhoods(store)]);
  const byId = new Map(all.map(n => [n.id, n]));
  const scope = new Map();
  for (const a of assignments) {
    if (!byId.has(a.neighborhoodId)) continue;
    const current = scope.get(a.neighborhoodId);
    if (!a.street) scope.set(a.neighborhoodId, null);
    else if (current !== null) scope.set(a.neighborhoodId, new Set([...(current || []), a.street]));
  }
  const list = [...scope.entries()].map(([id, streets]) => {
    const n = byId.get(id);
    const lock = neighborhoodLock(n, rep, settings);
    return {
      id, name: n.name, tier: n.tier, status: n.status, holdReason: n.holdReason || '', cityKey: n.cityKey,
      importedCount: n.importedCount || 0, locked: lock.locked, lockReason: lock.reason,
      streets: streets ? [...streets].sort() : null, center: n.center || null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { neighborhoods: list, scope };
}

export function houseInScope(house, territory) {
  if (!territory.scope.has(house.neighborhoodId)) return false;
  const streets = territory.scope.get(house.neighborhoodId);
  return streets === null || streets.has(house.street);
}

// Compact house record for the phone: address and outcome summary only.
export function phoneHouse(house, repKey) {
  const s = house.summary || {};
  return {
    id: house.id, n: house.neighborhoodId, street: house.street, number: house.number,
    ...(house.unit ? { unit: house.unit } : {}),
    lat: house.lat, lng: house.lng,
    ...(house.noKnock ? { noKnock: { source: house.noKnock.source } } : {}),
    ...(house.jurisdictionHold ? { jurisdictionHold: true } : {}),
    summary: {
      lastOutcome: s.lastOutcome || null, lastAt: s.lastAt || null, byMe: Boolean(s.lastRepId && s.lastRepId === repKey),
      seasonKey: s.seasonKey || '', seasonAttempts: s.seasonAttempts || 0, attempts: s.attempts || 0,
      comeBackAt: s.comeBackAt || null, looks: s.looks || 0, sold: Boolean(s.sold), signFlagged: Boolean(s.signFlagged),
      quotedAmount: s.quotedAmount ?? null, lastKnockId: s.lastKnockId || null,
    },
    updatedAt: house.updatedAt || null,
  };
}

/* Houses the rep may see: unlocked, assigned, not excluded. `since` (ISO) returns only houses
   changed since then (removed or newly locked areas are signalled by the territory list). */
// A delta read (since) uses the knock_houses (neighborhoodId, updatedAt) index. Without that index
// it reads the whole neighborhood and filters here instead, so the index only saves reads.
export async function territoryHouses(store, rep, territory, { since = '' } = {}) {
  const houses = [];
  let indexed = Boolean(since);
  for (const n of territory.neighborhoods) {
    if (n.locked) continue;
    let rows = null;
    if (indexed) {
      rows = await store.query('knock_houses', { where: [['neighborhoodId', '==', n.id], ['updatedAt', '>=', since]], orderBy: [['updatedAt', 'ASCENDING']] }).catch(error => {
        if (error?.code !== 'knock_index_required') throw error;
        indexed = false;
        return null;
      });
    }
    if (!rows) rows = (await store.query('knock_houses', { where: [['neighborhoodId', '==', n.id]] })).filter(house => !since || String(house.updatedAt || '') >= since);
    for (const house of rows) {
      if (house.excluded || !houseInScope(house, territory)) continue;
      houses.push(phoneHouse(house, rep.repKey));
    }
  }
  return houses;
}

/* The rep's open shift, ending it at the last door when it has sat idle past the limit. */
export async function openShift(store, repKey, settings, now) {
  const rows = await store.query('knock_shifts', { where: [['repKey', '==', repKey], ['endedAt', '==', null]] });
  let open = null;
  for (const shift of rows.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))) {
    const timing = shiftTiming(shift, now, settings.shift.idleAutoEndHours);
    if (timing?.autoEnded) {
      const endedAt = new Date(timing.endAt).toISOString();
      await store.commit([write.patch('knock_shifts', shift.id, { endedAt, endReason: 'idle', updatedAt: new Date(now).toISOString() }, shift.__updateTime)]).catch(error => {
        if (error.code !== 'knock_conflict') throw error;
      });
      continue;
    }
    if (!open) open = shift;
  }
  return open ? publicShift(open, settings, now) : null;
}

export function publicShift(shift, settings, now) {
  const timing = shiftTiming(shift, now, settings.shift.idleAutoEndHours);
  return {
    id: shift.id, startedAt: shift.startedAt, endedAt: shift.endedAt || null, endReason: shift.endReason || null,
    breaks: shift.breaks || [], lastDoorAt: shift.lastDoorAt || null, doors: shift.doors || 0, cityKey: shift.cityKey,
    knockingMs: timing?.knockingMs || 0, onBreak: Boolean(timing?.onBreak),
  };
}

export async function repHome(store, rep, settings, now) {
  const territory = await repTerritory(store, rep, settings);
  const shift = await openShift(store, rep.repKey, settings, now);
  return { territory: { neighborhoods: territory.neighborhoods }, shift };
}

export function requireNeighborhood(nbhd) {
  if (!nbhd) throw knockFailure('That neighborhood was not found.', 404, 'knock_neighborhood_missing');
  return nbhd;
}
