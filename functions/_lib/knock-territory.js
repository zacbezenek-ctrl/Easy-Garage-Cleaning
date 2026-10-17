// Territory: neighborhoods, assignments, locks and the houses a rep may see.
// Reps see only what is assigned to them. Premium neighborhoods need a rep cleared for Premium;
// Hold neighborhoods (and any neighborhood whose city has no rule in settings) are locked for all.
// An assignment is an admin's (source absent or 'admin') or a rep's own claim (source 'self'): with
// settings.territory.selfClaim on, an active rep may claim an open neighborhood nobody else works,
// up to settings.territory.maxSelfClaims at once, until they release it or an admin removes it.
import { knockFailure, write } from './knock-store.js';
import { shiftTiming } from '../../crew/knock-stats.js';
import { bboxCenter, neighborhoodCenter, pointsSummary } from '../../crew/knock-doors.js';

export async function loadNeighborhoods(store) {
  const rows = await store.list('knock_neighborhoods');
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

// kind names the rule (missing, hold, town, premium) so a list can count what it leaves out.
export function neighborhoodLock(nbhd, rep, settings) {
  if (!nbhd) return { locked: true, reason: 'Neighborhood not found', kind: 'missing' };
  if (nbhd.status === 'hold') return { locked: true, reason: nbhd.holdReason ? `On hold: ${nbhd.holdReason}` : 'On hold', kind: 'hold' };
  if (!settings?.cities?.[nbhd.cityKey]) return { locked: true, reason: 'No knocking rules set for this town', kind: 'town' };
  if (nbhd.tier === 'Premium' && !rep?.premiumCleared && rep?.role !== 'admin') return { locked: true, reason: 'Premium: needs Premium clearance', kind: 'premium' };
  return { locked: false, reason: '', kind: '' };
}

const isSelf = assignment => assignment?.source === 'self';
const validBbox = bbox => Boolean(bboxCenter(bbox));

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
  const scope = new Map(), byAdmin = new Set();
  for (const a of assignments) {
    if (!byId.has(a.neighborhoodId)) continue;
    if (!isSelf(a)) byAdmin.add(a.neighborhoodId);
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
      streets: streets ? [...streets].sort() : null, center: neighborhoodCenter(n), bbox: validBbox(n.bbox) ? n.bbox : null,
      // 'self': the rep claimed it and may release it; 'admin': an admin assigned it.
      source: byAdmin.has(id) ? 'admin' : 'self',
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { neighborhoods: list, scope };
}

/* ---- Choosing a neighborhood ---- */

const CENTER_SAMPLE = 300;
const CENTER_FILLS_PER_READ = 2;

async function sampledCenter(store, neighborhoodId) {
  const rows = await store.query('knock_houses', { where: [['neighborhoodId', '==', neighborhoodId]], select: ['lat', 'lng'], limit: CENTER_SAMPLE });
  return pointsSummary(rows);
}

/* A neighborhood with no stored center or bbox (seeded, never placed by the house import) gets one
   from a bounded sample of its houses, stored once so no later read scans its houses again. At most
   `limit` neighborhoods per call, CENTER_SAMPLE houses each. Updates the rows in place. */
export async function fillNeighborhoodCenters(store, neighborhoods, nowIso, { limit = CENTER_FILLS_PER_READ } = {}) {
  let filled = 0;
  for (const n of neighborhoods) {
    if (filled >= limit) break;
    if (neighborhoodCenter(n) || n.importedCount === 0 || n.centerSource === 'none') continue;
    filled += 1;
    const summary = await sampledCenter(store, n.id);
    const patch = summary ? { center: summary.center, bbox: summary.bbox, centerSource: 'sample', centerAt: nowIso } : { centerSource: 'none', centerAt: nowIso };
    try {
      await store.commit([write.patch('knock_neighborhoods', n.id, patch, n.__updateTime)]);
      Object.assign(n, patch);
    } catch (error) {
      // A concurrent admin edit wins; a later read fills it instead.
      if (error?.code !== 'knock_conflict') throw error;
    }
  }
  return filled;
}

const publicNeighborhood = (n, lock) => ({
  id: n.id, name: n.name, tier: n.tier || 'Volume', status: n.status, holdReason: n.holdReason || '', cityKey: n.cityKey,
  importedCount: n.importedCount ?? null, locked: lock.locked, lockReason: lock.reason,
  center: neighborhoodCenter(n), bbox: validBbox(n.bbox) ? n.bbox : null,
});

export function selfClaimRules(settings) {
  const rules = settings?.territory || {};
  return { enabled: rules.selfClaim === true, max: Number.isInteger(rules.maxSelfClaims) && rules.maxSelfClaims > 0 ? rules.maxSelfClaims : 2 };
}

// Neighborhoods the rep holds by their own claim (known: the neighborhood ids that still exist, when read).
const selfClaimCount = (assignments, repKey, known = null) =>
  new Set(assignments.filter(a => a.active === true && a.repKey === repKey && isSelf(a) && (!known || known.has(a.neighborhoodId))).map(a => a.neighborhoodId)).size;

/* The neighborhoods a rep may work or claim, for the phone's Choose area screen: each one the rep
   holds ('mine', locked or not, source self or admin) and each one they may claim now ('open': not on
   hold, a town rule, Premium only when cleared, houses imported, nobody else assigned). The rest are
   only counted in hidden (hold, town, premium, taken, empty); another rep is never named. Reads the
   neighborhoods and the active assignments once, and houses only to place a neighborhood (above). */
export async function availableNeighborhoods(store, rep, settings, nowIso) {
  const [all, active] = await Promise.all([loadNeighborhoods(store), store.query('knock_assignments', { where: [['active', '==', true]] })]);
  const byNeighborhood = new Map();
  for (const a of active) {
    if (!byNeighborhood.has(a.neighborhoodId)) byNeighborhood.set(a.neighborhoodId, []);
    byNeighborhood.get(a.neighborhoodId).push(a);
  }
  const rules = selfClaimRules(settings);
  const hidden = { hold: 0, town: 0, premium: 0, taken: 0, empty: 0 };
  const listed = [];
  for (const n of all) {
    const rows = byNeighborhood.get(n.id) || [];
    const own = rows.filter(a => a.repKey === rep.repKey);
    const lock = neighborhoodLock(n, rep, settings);
    if (own.length) listed.push({ n, lock, row: { claim: 'mine', source: own.some(a => !isSelf(a)) ? 'admin' : 'self', streets: own.some(a => !a.street) ? null : own.map(a => a.street).sort() } });
    else if (lock.locked) hidden[lock.kind] = (hidden[lock.kind] || 0) + 1;
    else if (rows.length) hidden.taken += 1;
    else if (n.importedCount === 0) hidden.empty += 1;
    else listed.push({ n, lock, row: { claim: 'open' } });
  }
  // Only listed neighborhoods need a place; the rep's own come first.
  listed.sort((a, b) => (a.row.claim === 'mine' ? 0 : 1) - (b.row.claim === 'mine' ? 0 : 1));
  await fillNeighborhoodCenters(store, listed.map(item => item.n), nowIso);
  return {
    neighborhoods: listed.map(({ n, lock, row }) => ({ ...publicNeighborhood(n, lock), ...row })), hidden,
    selfClaim: { enabled: rules.enabled, max: rules.max, used: selfClaimCount(active, rep.repKey, new Set(all.map(n => n.id))) },
  };
}

const NEIGHBORHOOD_ID = /^[A-Za-z0-9_.-]{1,150}$/;
function requireNeighborhoodId(value) {
  const id = String(value || '');
  if (!NEIGHBORHOOD_ID.test(id)) throw knockFailure('Pick a neighborhood.', 400, 'knock_invalid_neighborhood');
  return id;
}

/* A rep claims a whole neighborhood. Exclusive: the claim commits only if the neighborhood's document
   (and the rep's own) is unchanged since it was read, and both are read before the assignments, so of
   two reps claiming at once one wins and the other gets knock_claim_conflict or knock_neighborhood_taken.
   An admin assignment never counts as a self-claim and is never displaced. */
export async function claimNeighborhood(store, rep, settings, { neighborhoodId }, nowIso) {
  const rules = selfClaimRules(settings);
  if (!rules.enabled) throw knockFailure('Picking your own neighborhood is turned off. Ask your lead to assign one.', 403, 'knock_self_claim_off');
  const id = requireNeighborhoodId(neighborhoodId);
  // The guards first, the assignments second (see above).
  const [nbhd, repDoc] = await Promise.all([store.get('knock_neighborhoods', id), store.get('knock_reps', rep.repKey)]);
  requireNeighborhood(nbhd);
  if (!repDoc) throw knockFailure('Your canvassing profile was not found. Reload and retry.', 404, 'knock_rep_missing');
  const lock = neighborhoodLock(nbhd, rep, settings);
  if (lock.locked) throw knockFailure(`${nbhd.name} is locked. ${lock.reason}.`, 409, 'knock_locked');
  if (nbhd.importedCount === 0) throw knockFailure(`No houses are loaded for ${nbhd.name} yet.`, 409, 'knock_neighborhood_empty');
  const [rows, mine] = await Promise.all([
    store.query('knock_assignments', { where: [['neighborhoodId', '==', id]] }),
    activeAssignments(store, rep.repKey),
  ]);
  const active = rows.filter(a => a.active === true);
  if (active.some(a => a.repKey === rep.repKey && !a.street)) return { neighborhoodId: id, claimed: false, already: true };
  if (active.some(a => a.repKey !== rep.repKey)) throw knockFailure(`Another rep is working ${nbhd.name}. Pick another neighborhood.`, 409, 'knock_neighborhood_taken');
  const used = selfClaimCount(mine, rep.repKey);
  if (used >= rules.max) throw knockFailure(`You can hold ${rules.max} neighborhood${rules.max === 1 ? '' : 's'} at a time. Release one first.`, 409, 'knock_claim_limit', { max: rules.max, used });
  // Place a neighborhood that has no center yet, so "near me" can sort it from now on.
  const summary = neighborhoodCenter(nbhd) ? null : await sampledCenter(store, id);
  const placed = summary ? { center: summary.center, bbox: summary.bbox, centerSource: 'sample', centerAt: nowIso } : {};
  const assignment = {
    repKey: rep.repKey, neighborhoodId: id, street: '', active: true, source: 'self',
    assignedAt: nowIso, assignedBy: rep.username || rep.repKey, endedAt: null, updatedAt: nowIso,
  };
  try {
    await store.commit([
      write.patch('knock_neighborhoods', id, { territoryChangedAt: nowIso, ...placed }, nbhd.__updateTime),
      write.patch('knock_reps', rep.repKey, { selfClaimsChangedAt: nowIso }, repDoc.__updateTime),
      write.set('knock_assignments', assignmentId(rep.repKey, id), assignment),
    ]);
  } catch (error) {
    if (error.code === 'knock_conflict') throw knockFailure(`${nbhd.name} changed at the same moment. Refresh and try again.`, 409, 'knock_claim_conflict');
    throw error;
  }
  return { neighborhoodId: id, claimed: true, used: used + 1, max: rules.max };
}

/* A rep releases their own claim. An admin's assignment stays until an admin removes it. Doors
   synced later for that neighborhood are refused unless they were logged before the release. */
export async function releaseNeighborhood(store, rep, { neighborhoodId }, nowIso) {
  const id = requireNeighborhoodId(neighborhoodId);
  const docId = assignmentId(rep.repKey, id);
  const current = await store.get('knock_assignments', docId);
  if (current?.active !== true) return { neighborhoodId: id, released: false };
  if (!isSelf(current)) throw knockFailure('Your lead assigned this neighborhood. Ask them to take it off your list.', 409, 'knock_assigned_by_admin');
  await store.commit([write.patch('knock_assignments', docId, { active: false, endedAt: nowIso, endedBy: rep.username || rep.repKey, updatedAt: nowIso }, current.__updateTime)]);
  return { neighborhoodId: id, released: true };
}

/* For a door that would be refused as outside the rep's territory: the rep's ended assignment that
   covered the house when the door was logged (an offline door synced after a release or an admin's
   removal), or null. Read only for such a door, one query per neighborhood. */
export async function endedAssignmentFor(store, repKey, house, atMs, cache = new Map()) {
  if (!cache.has(house.neighborhoodId)) {
    cache.set(house.neighborhoodId, store.query('knock_assignments', { where: [['repKey', '==', repKey], ['neighborhoodId', '==', house.neighborhoodId]] }));
  }
  const rows = await cache.get(house.neighborhoodId);
  return rows.find(a => a.active === false && (!a.street || a.street === house.street) &&
    Date.parse(a.assignedAt) <= atMs && atMs < Date.parse(a.endedAt)) || null;
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
// it reads the whole neighborhood and filters here instead: nothing breaks, but every refresh then
// costs a read per house, so create the index.
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
