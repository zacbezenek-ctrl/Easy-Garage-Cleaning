// Admin reads and changes for canvassing: reps, training, settings and territory. Sales and money
// live in knock-sales.js and knock-reports.js. Every function here assumes requireAdmin passed.
import { knockFailure, write } from './knock-store.js';
import { COMMISSION_FIELDS, isOwner, loadSettings, publicRep, repKeyFor, repPatch, requireOwner, sameSettings } from './knock-access.js';
import { assignmentId, loadNeighborhoods, requireNeighborhood } from './knock-territory.js';
import { seedNeighborhoodDocs } from './knock-seed.js';
import { DEFAULT_SETTINGS, mergeSettings, overlaySettings, PACKAGES, validateSettings } from '../../crew/knock-settings.js';
import { COLLECTED_V3_POLICY, D2D_GARAGE_SCOPE, validCollectionPolicy, validCommissionScope } from '../../crew/knock-money.js';
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

const fromDoc = doc => loadSettings({ get: async () => doc });

/* Where the owner's commission approval stands against the saved settings. Admins see
   it; only the owner may act on it. The fixed contract terms travel with it so the
   approval card shows exactly what an approval would record. */
export function compensationView(doc, settings, viewer) {
  const approval = doc?.compensationApproval && typeof doc.compensationApproval === 'object' ? doc.compensationApproval : null;
  const saved = doc?.settings || null;
  return {
    verified: settings.commission.verified === true, approvedAt: settings.commission.approvedAt || null, canApprove: isOwner(viewer),
    settingsSaved: Boolean(saved && doc.updatedBy && Number.isFinite(Date.parse(doc.updatedAt)) && COMMISSION_FIELDS.every(key => Object.hasOwn(saved.commission || {}, key)) && !validateSettings(saved).length),
    approval: approval && {
      contract: approval.contract ?? null, reference: approval.reference ?? null, reviewedBy: approval.reviewedBy ?? null, reviewedAt: approval.reviewedAt ?? null,
      payrollAnchorConfirmed: approval.payrollAnchorConfirmed === true, scope: approval.scope ?? null, collectionPolicy: approval.collectionPolicy ?? null,
      matchesSavedSettings: Boolean(saved) && sameSettings(approval.commission, saved.commission) && sameSettings(approval.payroll, saved.payroll),
    },
    terms: { contract: 'knock-collected-v3', rate: 0.25, collectionPolicy: COLLECTED_V3_POLICY, scope: D2D_GARAGE_SCOPE, packages: PACKAGES },
  };
}

export async function readSettings(store, viewer = null) {
  const stored = await store.get('knock_settings', 'current');
  return { settings: mergeSettings(stored?.settings || {}), defaults: DEFAULT_SETTINGS, updatedAt: stored?.updatedAt || null, updatedBy: stored?.updatedBy || null,
    compensation: compensationView(stored, await fromDoc(stored), viewer) };
}

/* Saves the settings field only. The owner's compensationApproval and planApproval live
   beside it in the same document and must survive an unrelated edit (a map tile, a
   holiday). They are bound to the exact commission/payroll and plan/gate they approved,
   so changing those terms stops them verifying until the owner approves again. */
export async function updateSettings(store, admin, { settings }, nowIso) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw knockFailure('Send the settings to save.', 400, 'knock_invalid_settings');
  const candidate = overlaySettings(settings);
  const problems = validateSettings(candidate);
  if (problems.length) throw knockFailure('Some settings are out of range.', 400, 'knock_invalid_settings', { problems });
  const stored = await store.get('knock_settings', 'current');
  const fields = { settings: candidate, updatedAt: nowIso, updatedBy: admin.user };
  const [before, after] = await Promise.all([fromDoc(stored), fromDoc({ ...(stored || {}), ...fields })]);
  await store.commit([write.upsert('knock_settings', 'current', fields)]);
  return { settings: mergeSettings(candidate),
    compensation: { verified: after.commission.verified, approvalInvalidated: before.commission.verified && !after.commission.verified } };
}

/* ---- Compensation approval (owner only) ---- */

const UNSAFE_TEXT = /[\u0000-\u001f\u007f]/;
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const approvalContent = approval => ({ contract: approval?.contract, reference: approval?.reference, payrollAnchorConfirmed: approval?.payrollAnchorConfirmed,
  scope: approval?.scope, collectionPolicy: approval?.collectionPolicy, commission: approval?.commission, payroll: approval?.payroll });
const sameApproval = (a, b) => sameSettings(JSON.parse(JSON.stringify(approvalContent(a))), JSON.parse(JSON.stringify(approvalContent(b))));
// The same terms, whatever the reference says.
const sameTerms = (a, b) => sameApproval({ ...a, reference: null }, { ...b, reference: null });

/* The owner records compensationApproval for the saved commission and payroll settings,
   with the exact fields knock-access.js loadSettings verifies. The request repeats what
   the owner saw; if the saved settings changed since, nothing is written. Nothing is
   approved by default and no other path writes this field.
   Body: { requestId, contract: 'knock-collected-v3', reference, payrollAnchorConfirmed: true,
     collectionPolicy: COLLECTED_V3_POLICY, scope: { ...D2D_GARAGE_SCOPE, garageOnlyPackages, junkRemovalPackages },
     commission, payroll }. Retrying the same request, or approving identical terms again,
   changes nothing (reviewedAt is kept, so sales already snapshotted keep their terms).
   Correcting only the reference of terms that already verify keeps reviewedBy/reviewedAt:
   approvedAt dates the terms, and a sale made offline under them must still snapshot them
   when it syncs. Any other change takes effect now; an earlier sale never inherits it. */
export async function approveCompensation(store, owner, body, nowIso) {
  requireOwner(owner);
  const { requestId, contract, payrollAnchorConfirmed, collectionPolicy, scope } = body || {};
  if (!UUID.test(String(requestId || ''))) throw knockFailure('Missing request id. Reload and retry.', 400, 'knock_invalid_request');
  if (contract !== 'knock-collected-v3') throw knockFailure('Only the knock-collected-v3 contract can be approved.', 400, 'knock_approval_contract');
  const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
  if (reference.length < 3 || reference.length > 120 || UNSAFE_TEXT.test(reference)) throw knockFailure('Give the approval a reference of 3 to 120 characters (the signed plan or decision record; no customer details).', 400, 'knock_approval_reference');
  if (payrollAnchorConfirmed !== true) throw knockFailure('Confirm the first day of the two-week pay cycle.', 400, 'knock_approval_anchor');
  if (!exactKeys(collectionPolicy, Object.keys(COLLECTED_V3_POLICY)) || !validCollectionPolicy(collectionPolicy)) throw knockFailure('The collection policy must be exactly the knock-collected-v3 terms.', 400, 'knock_approval_policy');
  const scopeKeys = [...Object.keys(D2D_GARAGE_SCOPE), 'garageOnlyPackages', 'junkRemovalPackages'];
  if (!exactKeys(scope, scopeKeys) || !validCommissionScope(scope)) throw knockFailure('Classify at least one package as garage-only work, each package at most once.', 400, 'knock_approval_scope');
  const doc = await store.get('knock_settings', 'current');
  const saved = doc?.settings;
  if (!saved || !doc.updatedBy || !Number.isFinite(Date.parse(doc.updatedAt)) || !COMMISSION_FIELDS.every(key => Object.hasOwn(saved.commission || {}, key)) || validateSettings(saved).length)
    throw knockFailure('Save the settings once, then approve the saved commission terms.', 409, 'knock_settings_unsaved');
  if (saved.commission.rate !== 0.25) throw knockFailure('The door-to-door contract pays 25% of the collected garage job. Save a 25% base rate first.', 409, 'knock_approval_rate');
  if (saved.payroll?.period !== 'biweekly' || !Object.hasOwn(saved.payroll, 'anchorDate')) throw knockFailure('Payroll must be every two weeks with a saved first day.', 409, 'knock_approval_payroll');
  if (!sameSettings(body.commission, saved.commission) || !sameSettings(body.payroll, saved.payroll))
    throw knockFailure('The saved commission or pay-period settings changed since you opened them. Reload and review them again.', 409, 'knock_settings_changed');
  const approval = { contract, reference, reviewedBy: owner.user, reviewedAt: nowIso, payrollAnchorConfirmed: true,
    collectionPolicy: { ...COLLECTED_V3_POLICY }, scope: { ...D2D_GARAGE_SCOPE, garageOnlyPackages: PACKAGES.filter(name => scope.garageOnlyPackages.includes(name)), junkRemovalPackages: PACKAGES.filter(name => scope.junkRemovalPackages.includes(name)) },
    commission: structuredClone(saved.commission), payroll: structuredClone(saved.payroll) };
  const receiptId = `compensation_${requestId.toLowerCase()}`;
  const replay = async () => {
    const receipt = await store.get('knock_receipts', receiptId);
    if (!receipt) return null;
    if (receipt.kind !== 'compensation_approval' || !sameApproval(receipt, approval)) throw knockFailure('That request already recorded different terms. Reload and review again.', 409, 'knock_approval_conflict');
    const current = await store.get('knock_settings', 'current');
    return { duplicate: true, referenceOnly: receipt.referenceOnly === true, compensation: compensationView(current, await fromDoc(current), owner) };
  };
  const prior = await replay();
  if (prior) return prior;
  const current = await fromDoc(doc);
  if (current.commission.verified && sameApproval(doc.compensationApproval, approval)) return { duplicate: true, referenceOnly: false, compensation: compensationView(doc, current, owner) };
  const referenceOnly = current.commission.verified && sameTerms(doc.compensationApproval, approval);
  if (referenceOnly) Object.assign(approval, { reviewedBy: doc.compensationApproval.reviewedBy, reviewedAt: doc.compensationApproval.reviewedAt });
  const next = { ...doc, compensationApproval: approval };
  const verified = await fromDoc(next);
  if (!verified.commission.verified) throw knockFailure('These terms would not verify against the saved settings. Nothing was approved.', 409, 'knock_approval_invalid');
  const previous = doc.compensationApproval ? { reference: doc.compensationApproval.reference ?? null, reviewedBy: doc.compensationApproval.reviewedBy ?? null, reviewedAt: doc.compensationApproval.reviewedAt ?? null } : null;
  try {
    await store.commit([
      write.patch('knock_settings', 'current', { compensationApproval: approval }, doc.__updateTime),
      write.create('knock_receipts', receiptId, { kind: 'compensation_approval', ...approval, previous, referenceOnly, recordedBy: owner.user, recordedAt: nowIso }),
    ]);
  } catch (error) {
    const replayed = await replay();
    if (replayed) return replayed;
    throw error;
  }
  return { duplicate: false, referenceOnly, compensation: compensationView(next, verified, owner) };
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
  const streetName = String(street || '').trim().toUpperCase().replace(/\s+/g, ' ').slice(0, 80);
  if (streetName && active) {
    const onStreet = await store.query('knock_houses', { where: [['neighborhoodId', '==', nbhd.id], ['street', '==', streetName]], limit: 1, select: ['street'] });
    if (!onStreet.length) throw knockFailure(`No imported houses on ${streetName} in ${nbhd.name}. Pick a street from the list.`, 400, 'knock_unknown_street');
  }
  const id = assignmentId(key, nbhd.id, streetName);
  const current = await store.get('knock_assignments', id);
  // source 'admin': an admin's assignment (a rep's own claim is 'self'); it replaces a claim of the same scope.
  const doc = {
    repKey: key, neighborhoodId: nbhd.id, street: streetName, active: Boolean(active), source: 'admin',
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

/* Doors the admin should review: logged in the after-sunset grace, outside the hours, on a City
   no-knock house or on an excluded house. Newest first. */
export const FLAG_LABELS = Object.freeze({
  after_sunset: 'Finished after sunset (grace)',
  outside_hours: 'Logged outside knocking hours',
  no_knock_list: 'Knocked a City no-knock house',
  excluded_house: 'Knocked an excluded house',
});

export async function flagsView(store) {
  const lists = await Promise.all(Object.keys(FLAG_LABELS).map(flag => store.query('knock_events', { where: [['flags', 'array-contains', flag]] })));
  const byId = new Map();
  for (const event of lists.flat()) byId.set(event.id, event);
  const events = [...byId.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 300);
  const [houses, reps] = await Promise.all([
    events.length ? store.getMany('knock_houses', [...new Set(events.filter(e => e.houseId).map(e => e.houseId))]) : new Map(),
    listReps(store),
  ]);
  return {
    labels: FLAG_LABELS,
    flags: events.map(e => ({
      id: e.id, type: e.type, at: e.at, flags: e.flags, outcome: e.outcome || null,
      rep: reps.find(r => r.repKey === e.repKey)?.displayName || e.repKey,
      address: houses.get(e.houseId) ? `${houses.get(e.houseId).number} ${houses.get(e.houseId).street}` : e.houseId || '',
    })),
  };
}

export { repKeyFor };
