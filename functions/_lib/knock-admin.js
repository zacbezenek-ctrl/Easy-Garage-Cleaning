// Admin reads and changes for canvassing: reps, training, settings and territory. Sales and money
// live in knock-sales.js and knock-reports.js. Every function here assumes requireAdmin passed.
import { knockFailure, write } from './knock-store.js';
import { loadSettings, publicRep, repKeyFor, repPatch } from './knock-access.js';
import { assignmentId, loadNeighborhoods, requireNeighborhood } from './knock-territory.js';
import { seedNeighborhoodDocs } from './knock-seed.js';
import { DEFAULT_SETTINGS, mergeSettings, overlaySettings, validateSettings } from '../../crew/knock-settings.js';
import { matchNoKnockList } from '../../crew/knock-doors.js';
import { validDate } from '../../crew/knock-time.js';
import { coverage } from '../../crew/knock-stats.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_KEY = /^(?:[a-z0-9._-]{1,64}|u_[0-9a-f]{2,120})$/;

function requireKey(value, label = 'rep') {
  const key = String(value || '');
  if (!SAFE_KEY.test(key)) throw knockFailure(`Unknown ${label}.`, 400, 'knock_invalid_key');
  return key;
}

export async function listReps(store) {
  const rows = await store.list('knock_reps');
  return rows.map(publicRep).sort((a, b) => (a.status === 'pending' ? -1 : 0) - (b.status === 'pending' ? -1 : 0) || a.displayName.localeCompare(b.displayName));
}

export async function updateRep(store, admin, { repKey, changes }, nowIso) {
  const key = requireKey(repKey);
  const current = await store.get('knock_reps', key);
  if (!current) throw knockFailure('That rep was not found.', 404, 'knock_rep_missing');
  if (changes?.leadKey) {
    const lead = await store.get('knock_reps', requireKey(changes.leadKey, 'lead'));
    if (!lead || lead.status !== 'active' || !['lead', 'admin'].includes(lead.role)) throw knockFailure('Pick an active lead.', 400, 'knock_invalid_lead');
  }
  const patch = repPatch({ ...current, repKey: key }, changes || {}, admin, nowIso);
  await store.commit([write.patch('knock_reps', key, patch, current.__updateTime)]);
  return publicRep({ ...current, ...patch, repKey: key });
}

export async function addTraining(store, admin, { requestId, repKey, date, minutes, note }, nowIso) {
  if (!UUID.test(String(requestId || ''))) throw knockFailure('Missing request id. Reload and retry.', 400, 'knock_invalid_request');
  const key = requireKey(repKey);
  if (!validDate(date)) throw knockFailure('Pick the training date.', 400, 'knock_invalid_date');
  const mins = Number(minutes);
  if (!Number.isInteger(mins) || mins <= 0 || mins > 720) throw knockFailure('Training minutes must be 1 to 720.', 400, 'knock_invalid_minutes');
  const existing = await store.get('knock_training', requestId);
  if (existing) return { duplicate: true, log: existing };
  const rep = await store.get('knock_reps', key);
  if (!rep) throw knockFailure('That rep was not found.', 404, 'knock_rep_missing');
  const log = { repKey: key, date, minutes: mins, note: String(note || '').slice(0, 200), loggedBy: admin.user, at: nowIso };
  await store.commit([
    write.create('knock_training', requestId, log),
    write.patch('knock_reps', key, { trainingMinutes: Number(rep.trainingMinutes || 0) + mins, updatedAt: nowIso }, rep.__updateTime),
  ]);
  return { duplicate: false, log: { ...log, id: requestId } };
}

export async function listTraining(store, { repKey = '' } = {}) {
  const rows = repKey ? await store.query('knock_training', { where: [['repKey', '==', requireKey(repKey)]] }) : await store.list('knock_training');
  return rows.map(({ __updateTime, ...row }) => row).sort((a, b) => b.date.localeCompare(a.date));
}

export async function readSettings(store) {
  const stored = await store.get('knock_settings', 'current');
  return { settings: mergeSettings(stored?.settings || {}), defaults: DEFAULT_SETTINGS, updatedAt: stored?.updatedAt || null, updatedBy: stored?.updatedBy || null };
}

export async function updateSettings(store, admin, { settings }, nowIso) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw knockFailure('Send the settings to save.', 400, 'knock_invalid_settings');
  const candidate = overlaySettings(settings);
  const problems = validateSettings(candidate);
  if (problems.length) throw knockFailure('Some settings are out of range.', 400, 'knock_invalid_settings', { problems });
  await store.commit([write.set('knock_settings', 'current', { settings: candidate, updatedAt: nowIso, updatedBy: admin.user })]);
  return { settings: mergeSettings(candidate) };
}

/* ---- Territory ---- */

export async function seedNeighborhoods(store, nowIso) {
  const existing = new Set((await loadNeighborhoods(store)).map(n => n.id));
  const missing = seedNeighborhoodDocs(nowIso).filter(doc => !existing.has(doc.id));
  if (missing.length) await store.commit(missing.map(doc => write.create('knock_neighborhoods', doc.id, doc)));
  return { created: missing.map(doc => doc.id), existing: existing.size };
}

export async function updateNeighborhood(store, admin, { id, changes }, nowIso) {
  const nbhd = requireNeighborhood(await store.get('knock_neighborhoods', String(id || '')));
  const patch = {};
  if ('status' in changes) {
    if (!['open', 'hold'].includes(changes.status)) throw knockFailure('Status must be open or hold.', 400, 'knock_invalid_status');
    patch.status = changes.status;
    patch.statusChangedAt = nowIso;
    patch.statusChangedBy = admin.user;
    if (changes.status === 'open') patch.holdReason = '';
  }
  if ('holdReason' in changes) patch.holdReason = String(changes.holdReason || '').slice(0, 160);
  if ('tier' in changes) {
    if (!['Premium', 'Volume'].includes(changes.tier)) throw knockFailure('Tier must be Premium or Volume.', 400, 'knock_invalid_tier');
    patch.tier = changes.tier;
  }
  if ('cityKey' in changes) {
    if (!/^[a-z0-9-]{2,40}$/.test(String(changes.cityKey || ''))) throw knockFailure('Unknown town.', 400, 'knock_invalid_city');
    patch.cityKey = changes.cityKey;
  }
  if (!Object.keys(patch).length) throw knockFailure('Nothing to change.', 400, 'knock_nothing_to_change');
  patch.updatedAt = nowIso;
  await store.commit([write.patch('knock_neighborhoods', nbhd.id, patch, nbhd.__updateTime)]);
  return { ...nbhd, ...patch };
}

export async function setAssignment(store, admin, { repKey, neighborhoodId, street = '', active = true }, nowIso) {
  const key = requireKey(repKey);
  const [rep, nbhd] = await Promise.all([store.get('knock_reps', key), store.get('knock_neighborhoods', String(neighborhoodId || ''))]);
  if (!rep) throw knockFailure('That rep was not found.', 404, 'knock_rep_missing');
  requireNeighborhood(nbhd);
  const streetName = String(street || '').trim().toUpperCase().slice(0, 80);
  const id = assignmentId(key, nbhd.id, streetName);
  const current = await store.get('knock_assignments', id);
  const doc = {
    repKey: key, neighborhoodId: nbhd.id, street: streetName, active: Boolean(active),
    assignedAt: active ? nowIso : (current?.assignedAt || nowIso), assignedBy: admin.user,
    endedAt: active ? null : nowIso, updatedAt: nowIso,
  };
  await store.commit([write.set('knock_assignments', id, doc)]);
  return { id, ...doc };
}

export async function listAssignments(store) {
  return (await store.query('knock_assignments', { where: [['active', '==', true]] })).map(({ __updateTime, ...row }) => row);
}

export async function neighborhoodHouses(store, neighborhoodId) {
  const nbhd = requireNeighborhood(await store.get('knock_neighborhoods', String(neighborhoodId || '')));
  const houses = await store.query('knock_houses', { where: [['neighborhoodId', '==', nbhd.id]] });
  return { neighborhood: nbhd, houses: houses.map(({ __updateTime, ...h }) => h) };
}

export async function excludeHouses(store, admin, { houseIds, excluded }, nowIso) {
  const ids = [...new Set((houseIds || []).map(String))].slice(0, 2000);
  if (!ids.length) throw knockFailure('Pick at least one house.', 400, 'knock_nothing_to_change');
  const found = await store.getMany('knock_houses', ids);
  const writes = [...found.values()].map(h => write.patch('knock_houses', h.id, { excluded: Boolean(excluded), excludedBy: admin.user, updatedAt: nowIso }));
  await store.commit(writes);
  return { changed: writes.length };
}

export async function excludeUnits(store, admin, { neighborhoodId, excluded = true }, nowIso) {
  const { houses } = await neighborhoodHouses(store, neighborhoodId);
  const units = houses.filter(h => h.hasUnit && Boolean(h.excluded) !== Boolean(excluded));
  if (units.length) await store.commit(units.map(h => write.patch('knock_houses', h.id, { excluded: Boolean(excluded), excludedBy: admin.user, updatedAt: nowIso })));
  return { changed: units.length };
}

/* Paste the City's no-solicitation list. preview (apply=false) shows matches; apply flags them. */
export async function importNoKnock(store, admin, { text, apply = false, requestId }, nowIso) {
  const body = String(text || '');
  if (body.length > 200000) throw knockFailure('That list is too long. Paste it in parts.', 413, 'knock_request_too_large');
  const houses = await store.list('knock_houses');
  const { matched, unmatched } = matchNoKnockList(body, houses);
  const ids = [...new Set(matched.map(m => m.houseId))];
  if (apply) {
    if (!UUID.test(String(requestId || ''))) throw knockFailure('Missing request id. Reload and retry.', 400, 'knock_invalid_request');
    const byId = new Map(houses.map(h => [h.id, h]));
    const writes = ids.filter(id => byId.get(id)?.noKnock?.source !== 'city')
      .map(id => write.patch('knock_houses', id, { noKnock: { source: 'city', at: nowIso, by: admin.user }, updatedAt: nowIso }));
    writes.push(write.create('knock_imports', requestId, { kind: 'no_knock_city', lines: body.split(/\r?\n/).filter(l => l.trim()).length, matched: ids.length, unmatched: unmatched.slice(0, 500), at: nowIso, by: admin.user }));
    await store.commit(writes);
  }
  return { matched: ids.length, unmatched, applied: Boolean(apply) };
}

export async function clearNoKnock(store, admin, { houseId }, nowIso) {
  const house = await store.get('knock_houses', String(houseId || ''));
  if (!house) throw knockFailure('That house was not found.', 404, 'knock_house_missing');
  if (house.summary?.signFlagged) throw knockFailure('A rep flagged a no-soliciting sign here. Void that knock to clear it.', 409, 'knock_sign_flagged');
  await store.commit([write.patch('knock_houses', house.id, { noKnock: null, updatedAt: nowIso, noKnockClearedBy: admin.user })]);
  return { cleared: true };
}

/* Coverage per neighborhood and street: houses knocked, percent, looks, sales, last knocked and
   who is there now (an open shift whose last door was there within the configured minutes). */
export async function coverageView(store, nowMs) {
  const [settings, neighborhoods, houses, open, reps] = await Promise.all([
    loadSettings(store), loadNeighborhoods(store),
    store.query('knock_houses', { select: ['neighborhoodId', 'street', 'excluded', 'jurisdictionHold', 'noKnock', 'summary'] }),
    store.query('knock_shifts', { where: [['endedAt', '==', null]] }),
    listReps(store),
  ]);
  const rows = coverage({ houses, neighborhoods, activeShifts: open, reps, now: nowMs, hereNowMinutes: settings.coverage.hereNowMinutes });
  return { coverage: rows.map(row => ({ ...row, tier: neighborhoods.find(n => n.id === row.id)?.tier || '', status: neighborhoods.find(n => n.id === row.id)?.status || '' })) };
}

export { repKeyFor };
