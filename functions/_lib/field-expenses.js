import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields, encodeFirestoreFields } from './firestore-job.js';
import { fieldCancelled, fieldCompletionMissing, fieldFailure, fieldId, fieldPhotos, fieldRequestId, fieldStage, fieldText } from './field-execution.js';
import { createFieldStore } from './field-execution-store.js';
import { assignmentKey } from './job-assignment.js';
import { commitConflict, commitFailure } from './firestore-errors.js';

// Field costs live in jobs/{jobId}/fieldExpenses/{requestId}. Nothing is copied
// onto the job document, so crew, customer and dispatch projections of the job
// cannot carry amounts. Manager corrections and voids leave an idempotency
// receipt at jobs/{jobId}/fieldExpenseRequests/{requestId}. The deny-all
// Firestore rule keeps both subcollections server-only; every read goes through
// the assignment-checked API.
//
// Closeout (FUN-19): a "None" tap for a cost group is stored per kind,
// create-only at jobs/{jobId}/fieldExpenseCloseout/{kind}, for each kind of the
// group that has no active entry, with one request receipt. A kind's state is
// always derived: an active entry of that kind wins over its "None", and
// voiding the entry falls back to the attestation or to missing. A group is
// confirmed only when each of its kinds is, so a fuel entry never confirms
// helpers or damage claims.
// A shared load is one row per job written in one commit. Every row carries
// the same share {loadId, primaryJobId, totalCents, parts} and its own part as
// amountCents, so per-job and date-range totals never count a load twice.
//
// Job-costing consumers (server-side only; never call these from a browser):
//   sumFieldExpenses(env, jobId, { store }) -> Promise<{ jobId, currency,
//     totalCents, costCents, recoveryIncomeCents, byKind, byPayer, count,
//     voidCount, pendingCount, invalidCount, receiptCount, sharedCount,
//     complete }> (full shape in its JSDoc below).
//     env is the Pages Functions env and comes FIRST. store is optional and
//     defaults to createFieldExpenseStore(env); tests inject a fake with
//     listExpenses(jobId).
//   fieldExpenseCloseoutStatus(env, jobId, { store }) -> the job's derived
//     closeout kinds and groups (entered | none | missing); the injected store
//     also needs listAttestations(jobId).
//   fieldExpenseJobCosts(env, jobId, { store }) -> job-costing components with
//     status complete | partial | unknown (null while a closeout group is
//     unconfirmed); same store as the closeout status.
//   fieldExpenseRange(env, { start, end }, { store }) -> per-job totals for a
//     Mountain incurredOn range of at most FIELD_EXPENSE_RANGE_DAYS days,
//     both dates included.
// The totals count only receipt-verified (or receipt-free) non-void entries and
// report pending or unreadable rows (complete:false) instead of treating them as
// zero. sumFieldExpenses and fieldExpenseRange total recorded rows only; use
// fieldExpenseJobCosts when "no entry" must not be read as $0.
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
export const FIELD_EXPENSE_KINDS = ['material', 'dump_fee', 'subcontractor', 'fuel', 'damage_claim', 'other', 'recovery_income'];
// Recovery income (scrap, resale) is money received: entered as a positive
// amount and subtracted from the job's field cost. It has no payer.
export const FIELD_EXPENSE_INCOME_KINDS = ['recovery_income'];
export const FIELD_EXPENSE_COST_KINDS = FIELD_EXPENSE_KINDS.filter(kind => !FIELD_EXPENSE_INCOME_KINDS.includes(kind));
export const FIELD_EXPENSE_PAYERS = ['company_card', 'crew_reimbursable', 'account_billed'];
// A damage claim belongs to the one job whose damage photos it cites.
export const FIELD_EXPENSE_SHAREABLE_KINDS = FIELD_EXPENSE_KINDS.filter(kind => kind !== 'damage_claim');
export const FIELD_EXPENSE_SHARE_JOBS = 6, FIELD_EXPENSE_SHARE_WEIGHT_MAX = 100, FIELD_EXPENSE_DAMAGE_PHOTOS = 10;
export const FIELD_EXPENSE_CLOSEOUT_GROUPS = [
  { id: 'material', kinds: ['material'], required: true },
  { id: 'dump_fee', kinds: ['dump_fee'], required: true },
  { id: 'other_costs', kinds: ['subcontractor', 'fuel', 'damage_claim', 'other'], required: false },
];
const CLOSEOUT_KINDS = FIELD_EXPENSE_CLOSEOUT_GROUPS.flatMap(group => group.kinds);
const closeoutGroup = kind => FIELD_EXPENSE_CLOSEOUT_GROUPS.find(group => group.kinds.includes(kind)) || null;
const CLOSEOUT_MISSING = { material: 'Job costs: record the materials bought for this job, or tap “No materials” in Job costs.', dump_fee: 'Job costs: record dump or disposal fees, or tap “No dump fees” in Job costs.' };
const NOTE_REQUIRED = { other: 'Describe what an “other” cost was for.', damage_claim: 'Describe the damage claim and what was paid.' };
export const FIELD_EXPENSE_MAX_CENTS = 500000;
// Capacity counts non-void entries (verified and pending). Managers keep a
// higher allowance so one crew member cannot block operations; the stored
// limit (void rows included) keeps every job listing verifiable in one read.
export const FIELD_EXPENSE_JOB_LIMIT = 100;
export const FIELD_EXPENSE_MANAGER_JOB_LIMIT = 150;
export const FIELD_EXPENSE_PENDING_LIMIT = 5;
export const FIELD_EXPENSE_RANGE_DAYS = 92;
const AUDIT_LIMIT = 50, LIST_LIMIT = 300, RANGE_LIMIT = 2000;
export const FIELD_EXPENSE_STORED_LIMIT = LIST_LIMIT;
const EDITABLE = ['kind', 'amountCents', 'vendor', 'note', 'incurredOn', 'payer', 'damagePhotoIds'];
const AUDITED = [...EDITABLE, 'status', 'loadTotalCents'];

export const fieldExpensesEnabled = env => env?.FIELD_EXPENSES_ENABLED === 'true';
// Unset, closeout is a record-only prompt. Exactly "true" (with job costs on)
// also makes field completion require every required group entered or "None".
export const fieldExpenseCloseoutRequired = env => fieldExpensesEnabled(env) && env?.FIELD_EXPENSE_CLOSEOUT_REQUIRED === 'true';
export const fieldExpenseAmount = value => Number.isSafeInteger(value) && value >= 1 && value <= FIELD_EXPENSE_MAX_CENTS;
export const fieldExpenseDate = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
export const validExpenseDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const dayNumber = value => Date.parse(`${value}T12:00:00Z`) / 86400000;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const photoIds = value => Array.isArray(value) ? value.filter(fieldRequestId).map(id => id.toLowerCase()).slice(0, FIELD_EXPENSE_DAMAGE_PHOTOS) : [];
const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
export const fieldExpenseDamagePhotos = job => fieldPhotos(job).filter(photo => photo.category === 'damage');

// Largest-remainder split in integer cents: each part gets floor(total x
// weight / sum of weights), then the leftover cents go one each to the largest
// remainders, ties to the earlier part (the recording job is always first,
// then the others in job-ID order).
// The parts always sum to the total, and every part must be at least a cent.
export function splitSharedCents(totalCents, parts) {
  const weights = parts.map(part => part.weight), sum = weights.reduce((a, b) => a + b, 0);
  const cents = weights.map(weight => Math.floor(totalCents * weight / sum)), order = weights.map((weight, index) => ({ index, remainder: totalCents * weight % sum }));
  order.sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (let left = totalCents - cents.reduce((a, b) => a + b, 0), at = 0; left > 0; left--, at++) cents[order[at].index]++;
  if (cents.some(value => value < 1)) throw fieldFailure('This amount is too small to split across these jobs. Record it on one job instead.', 400, 'FIELD_EXPENSE_SHARE_INVALID');
  return cents;
}

// shares: [{jobId, weight}] including the recording job. Returns the parts in
// storage order: the recording job first, then the others by job ID in plain
// code-unit order, which is the same in every runtime and locale (the crew
// split preview sorts the same way).
export function fieldExpenseShareParts(jobId, kind, amountCents, shares) {
  const invalid = message => fieldFailure(message, 400, 'FIELD_EXPENSE_SHARE_INVALID');
  if (!FIELD_EXPENSE_SHAREABLE_KINDS.includes(kind)) throw invalid('A damage claim belongs to one job and cannot be split.');
  if (!Array.isArray(shares) || shares.length < 2 || shares.length > FIELD_EXPENSE_SHARE_JOBS) throw invalid(`Split a shared load across 2–${FIELD_EXPENSE_SHARE_JOBS} jobs, including this one.`);
  const seen = new Set();
  for (const share of shares) {
    if (!plain(share) || Object.keys(share).some(key => !['jobId', 'weight'].includes(key)) || !fieldId(share.jobId) || seen.has(share.jobId)) throw invalid('Choose each job in the split once.');
    if (!Number.isSafeInteger(share.weight) || share.weight < 1 || share.weight > FIELD_EXPENSE_SHARE_WEIGHT_MAX) throw invalid(`Give each job a share from 1 to ${FIELD_EXPENSE_SHARE_WEIGHT_MAX}.`);
    seen.add(share.jobId);
  }
  if (!seen.has(jobId)) throw invalid('Include this job in the split.');
  const ordered = [shares.find(share => share.jobId === jobId), ...shares.filter(share => share.jobId !== jobId).sort((a, b) => a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0)];
  const cents = splitSharedCents(amountCents, ordered);
  return ordered.map((share, index) => ({ jobId: share.jobId, weight: share.weight, amountCents: cents[index] }));
}

// Row IDs on the other jobs of a shared load: a version-8 UUID derived from
// the load's request ID and the job, so a replay addresses the same documents.
export function fieldExpenseShareId(loadId, jobId) {
  const hex = bytesToHex(sha256(new TextEncoder().encode(`field-expense-share:${loadId.toLowerCase()}:${jobId}`)));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function validFieldExpenseShare(share) {
  if (!plain(share) || !fieldRequestId(share.loadId) || !fieldId(share.primaryJobId) || !fieldExpenseAmount(share.totalCents) || !Array.isArray(share.parts) || share.parts.length < 2 || share.parts.length > FIELD_EXPENSE_SHARE_JOBS) return false;
  return new Set(share.parts.map(part => part?.jobId)).size === share.parts.length && share.parts[0]?.jobId === share.primaryJobId && share.parts[0]?.expenseId === share.loadId
    && share.parts.every(part => fieldId(part?.jobId) && fieldRequestId(part.expenseId) && Number.isSafeInteger(part.weight) && part.weight >= 1 && part.weight <= FIELD_EXPENSE_SHARE_WEIGHT_MAX && fieldExpenseAmount(part.amountCents))
    && share.parts.reduce((sum, part) => sum + part.amountCents, 0) === share.totalCents;
}

// One row per job of a shared load, built from the recording job's draft.
export function fieldExpenseShareRows(draft, parts, jobs) {
  const share = { loadId: draft.id, primaryJobId: draft.jobId, totalCents: draft.amountCents, parts: parts.map(part => ({ ...part, expenseId: part.jobId === draft.jobId ? draft.id : fieldExpenseShareId(draft.id, part.jobId) })) };
  return share.parts.map(part => ({ ...draft, id: part.expenseId, jobId: part.jobId, jobDate: fieldText(jobs.find(job => job.id === part.jobId)?.date, 10), amountCents: part.amountCents, share }));
}

// damagePhotos: the job's verified damage photo IDs (lowercase), when known.
export function fieldExpenseValues(input, { partial = false, damagePhotos = null } = {}) {
  const values = {};
  if (!partial || input.kind !== undefined) {
    if (!FIELD_EXPENSE_KINDS.includes(input.kind)) throw fieldFailure('Choose a supported type of cost.', 400, 'FIELD_EXPENSE_KIND_INVALID');
    values.kind = input.kind;
  }
  if (!partial || input.amountCents !== undefined) {
    if (!fieldExpenseAmount(input.amountCents)) throw fieldFailure(`Enter an amount between $0.01 and $${(FIELD_EXPENSE_MAX_CENTS / 100).toLocaleString('en-US')}.00. Larger purchases need operations approval.`, 400, 'FIELD_EXPENSE_AMOUNT_INVALID');
    values.amountCents = input.amountCents;
  }
  if (!partial || input.vendor !== undefined) {
    if (typeof input.vendor !== 'string' || input.vendor.trim().length < 2 || input.vendor.length > 120) throw fieldFailure('Enter the store, landfill or vendor (2–120 characters).', 400, 'FIELD_EXPENSE_VENDOR_INVALID');
    values.vendor = input.vendor.trim();
  }
  if (!partial || input.note !== undefined) {
    if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 1000)) throw fieldFailure('Notes must be no longer than 1,000 characters.', 400, 'FIELD_EXPENSE_NOTE_INVALID');
    values.note = fieldText(input.note, 1000);
  }
  // An older client that sends no payer records it as unspecified (null).
  if (input.payer !== undefined) {
    if (input.payer !== null && !FIELD_EXPENSE_PAYERS.includes(input.payer)) throw fieldFailure('Choose who paid: company card, crew (reimbursable) or billed to a company account.', 400, 'FIELD_EXPENSE_PAYER_INVALID');
    values.payer = input.payer;
  } else if (!partial) values.payer = null;
  if (input.damagePhotoIds !== undefined) {
    if (!Array.isArray(input.damagePhotoIds) || input.damagePhotoIds.length > FIELD_EXPENSE_DAMAGE_PHOTOS || input.damagePhotoIds.some(id => !fieldRequestId(id)) || new Set(input.damagePhotoIds.map(id => id.toLowerCase())).size !== input.damagePhotoIds.length) throw fieldFailure(`Choose up to ${FIELD_EXPENSE_DAMAGE_PHOTOS} damage photos saved on this job.`, 400, 'FIELD_EXPENSE_DAMAGE_PHOTOS_INVALID');
    values.damagePhotoIds = input.damagePhotoIds.map(id => id.toLowerCase());
  }
  const kind = values.kind ?? input.currentKind, note = values.note ?? input.currentNote ?? '', kindChanged = !partial || values.kind !== undefined;
  if (NOTE_REQUIRED[kind] && note.length < 3 && (kindChanged || values.note !== undefined)) throw fieldFailure(NOTE_REQUIRED[kind], 400, 'FIELD_EXPENSE_NOTE_INVALID');
  if (FIELD_EXPENSE_INCOME_KINDS.includes(kind) && ('payer' in values ? values.payer : input.currentPayer)) {
    if (values.payer) throw fieldFailure('Recovery income is money received, so it has no payer.', 400, 'FIELD_EXPENSE_PAYER_INVALID');
    values.payer = null;
  }
  const photos = 'damagePhotoIds' in values ? values.damagePhotoIds : photoIds(input.currentDamagePhotoIds);
  if (kind === 'damage_claim') {
    if (!photos.length) throw fieldFailure('Link at least one damage photo from this job. Add it under Job photos first.', 400, 'FIELD_EXPENSE_DAMAGE_PHOTOS_REQUIRED');
    if ('damagePhotoIds' in values && Array.isArray(damagePhotos) && photos.some(id => !damagePhotos.includes(id))) throw fieldFailure('Choose damage photos that are saved on this job.', 400, 'FIELD_EXPENSE_DAMAGE_PHOTOS_INVALID');
  } else if (photos.length) {
    if ('damagePhotoIds' in values) throw fieldFailure('Only damage claims link damage photos.', 400, 'FIELD_EXPENSE_DAMAGE_PHOTOS_INVALID');
    if (kindChanged) values.damagePhotoIds = [];
  } else if (!partial) delete values.damagePhotoIds;
  return values;
}

const validRow = entry => fieldExpenseAmount(entry.amountCents) && FIELD_EXPENSE_KINDS.includes(entry.kind) && (entry.payer == null || FIELD_EXPENSE_PAYERS.includes(entry.payer)) && (entry.share == null || validFieldExpenseShare(entry.share));
export function summarizeFieldExpenses(entries) {
  const byKind = Object.fromEntries(FIELD_EXPENSE_KINDS.map(kind => [kind, 0])), byPayer = Object.fromEntries([...FIELD_EXPENSE_PAYERS, 'unspecified'].map(payer => [payer, 0]));
  let costCents = 0, count = 0, voidCount = 0, pendingCount = 0, invalidCount = 0, receiptCount = 0, sharedCount = 0;
  for (const entry of entries) {
    if (entry.status === 'void') { voidCount++; continue; }
    if (entry.state !== 'applied') { pendingCount++; continue; }
    if (!validRow(entry)) { invalidCount++; continue; }
    byKind[entry.kind] += entry.amountCents; count++;
    if (!FIELD_EXPENSE_INCOME_KINDS.includes(entry.kind)) { costCents += entry.amountCents; byPayer[entry.payer || 'unspecified'] += entry.amountCents; }
    if (entry.receipt?.verified === true) receiptCount++;
    if (entry.share) sharedCount++;
  }
  // Unverified receipts and unreadable rows are reported, never silently
  // counted as zero, so a dashboard can distinguish "no costs" from "unknown".
  // totalCents is the net field cost: costs minus recovery income.
  const recoveryIncomeCents = FIELD_EXPENSE_INCOME_KINDS.reduce((sum, kind) => sum + byKind[kind], 0);
  return { currency: 'USD', totalCents: costCents - recoveryIncomeCents, costCents, recoveryIncomeCents, byKind, byPayer, count, voidCount, pendingCount, invalidCount, receiptCount, sharedCount, complete: pendingCount === 0 && invalidCount === 0 };
}

// Closeout derived from the job's stored rows and per-kind "None"
// attestations ({kind, attestation:'none'}). Each kind is entered (an active
// entry of it, pending receipts included), none (attested and no active entry)
// or missing. A group is entered when any of its kinds is, none when every
// kind is attested, else missing; it is confirmed only when none of its kinds
// is missing (openKinds lists those). complete means every required group is
// confirmed (the completion gate); confirmed means every group is, optional
// ones included (needed for known job costs).
export function fieldExpenseCloseout(rows, attestations = []) {
  const kinds = Object.fromEntries(CLOSEOUT_KINDS.map(kind => {
    const active = rows.filter(row => row.status !== 'void' && row.kind === kind), attested = attestations.find(item => item?.kind === kind && item.attestation === 'none') || null;
    return [kind, { state: active.length ? 'entered' : attested ? 'none' : 'missing', active, attestation: active.length ? null : attested }];
  }));
  const groups = FIELD_EXPENSE_CLOSEOUT_GROUPS.map(group => {
    const active = group.kinds.flatMap(kind => kinds[kind].active), openKinds = group.kinds.filter(kind => kinds[kind].state === 'missing');
    const state = active.length ? 'entered' : openKinds.length ? 'missing' : 'none', attestation = state === 'none' ? group.kinds.map(kind => kinds[kind].attestation).sort((a, b) => String(a.at).localeCompare(String(b.at)))[0] : null;
    return { id: group.id, required: group.required, state, confirmed: !openKinds.length, openKinds, entryCount: active.length, pendingCount: active.filter(row => row.state !== 'applied').length, attestation };
  });
  const missing = groups.filter(group => group.required && !group.confirmed).map(group => group.id);
  return { kinds: Object.fromEntries(CLOSEOUT_KINDS.map(kind => [kind, kinds[kind].state])), groups, missing, complete: !missing.length, confirmed: groups.every(group => group.confirmed) };
}

// Job-costing components (funnel design §6.3) by kind. A closeout kind is
// known once it is entered or "None" (a known 0); until then it is unknown
// (null), never 0, even when another kind of its group was recorded. Recovery
// income is money received and needs no attestation. A component is partial
// while any of its entries waits for a receipt or cannot be read, so its
// amount can still move.
export const FIELD_EXPENSE_COMPONENTS = { material: 'materials', dump_fee: 'disposal', subcontractor: 'subcontract', fuel: 'fuel', damage_claim: 'damageClaims', other: 'other', recovery_income: 'recoveryIncome' };
export function fieldExpenseCosts(rows, attestations = []) {
  const closeout = fieldExpenseCloseout(rows, attestations), totals = summarizeFieldExpenses(rows), components = {};
  for (const kind of FIELD_EXPENSE_KINDS) {
    const group = closeoutGroup(kind), state = closeout.kinds[kind] || 'entered';
    const open = rows.filter(row => row.status !== 'void' && row.kind === kind && (row.state !== 'applied' || !validRow(row))).length;
    components[FIELD_EXPENSE_COMPONENTS[kind]] = state === 'missing' ? { cents: null, status: 'unknown', basis: 'closeout_unconfirmed', group: group.id }
      : { cents: totals.byKind[kind], status: open ? 'partial' : 'complete', basis: state === 'none' ? 'attested_none' : 'recorded', group: group?.id || null, openCount: open };
  }
  const values = Object.values(components), unknown = values.filter(item => item.status === 'unknown');
  const status = unknown.length ? 'unknown' : values.some(item => item.status === 'partial') || !totals.complete ? 'partial' : 'complete';
  return {
    currency: 'USD', status, netCostCents: status === 'unknown' ? null : totals.totalCents, knownCostCents: totals.costCents, recoveryIncomeCents: totals.recoveryIncomeCents,
    reimbursableCents: totals.byPayer.crew_reimbursable, byPayer: totals.byPayer, components, missing: [...new Set(unknown.map(item => item.group))],
    coverage: { knownComponents: values.length - unknown.length, totalComponents: values.length, pendingCount: totals.pendingCount, invalidCount: totals.invalidCount, closeoutConfirmed: closeout.confirmed },
  };
}

const actorLabel = (id, name) => ({ id: fieldText(id, 120), name: fieldText(name || id, 150) });
function closeoutProjection(closeout, { manager = false, user = '', required = false } = {}) {
  const self = assignmentKey(user);
  return { required, complete: closeout.complete, confirmed: closeout.confirmed, missing: closeout.missing, groups: closeout.groups.map(group => ({
    id: group.id, required: group.required, state: group.state, confirmed: group.confirmed, openKinds: group.openKinds, entryCount: group.entryCount, pendingCount: group.pendingCount,
    attestedAt: group.attestation ? fieldText(group.attestation.at, 40) : null, attestedByYou: Boolean(group.attestation && self && assignmentKey(group.attestation.actorId) === self),
    ...(manager ? { attestedBy: group.attestation ? actorLabel(group.attestation.actorId, group.attestation.actorName) : null } : {}),
  })) };
}

const auditValues = value => Object.fromEntries(AUDITED.filter(key => value && typeof value === 'object' && key in value).map(key => [key, ['amountCents', 'loadTotalCents'].includes(key) ? (fieldExpenseAmount(value[key]) ? value[key] : null) : key === 'damagePhotoIds' ? photoIds(value[key]) : fieldText(value[key], 1000)]));
const shareProjection = entry => validFieldExpenseShare(entry.share) ? { primary: entry.share.primaryJobId === entry.jobId, primaryJobId: entry.share.primaryJobId, totalCents: entry.share.totalCents, parts: entry.share.parts.map(part => ({ jobId: part.jobId, weight: part.weight, amountCents: part.amountCents })) } : null;
export function fieldExpenseProjection(entry, { manager = false } = {}) {
  const valid = validRow(entry), kind = FIELD_EXPENSE_KINDS.includes(entry.kind) ? entry.kind : 'other';
  const base = {
    id: entry.id, kind, amountCents: fieldExpenseAmount(entry.amountCents) ? entry.amountCents : null, currency: 'USD', income: FIELD_EXPENSE_INCOME_KINDS.includes(kind),
    vendor: fieldText(entry.vendor, 120), note: fieldText(entry.note, 1000), createdAt: fieldText(entry.createdAt, 40), incurredOn: fieldText(entry.incurredOn, 10),
    payer: FIELD_EXPENSE_PAYERS.includes(entry.payer) ? entry.payer : null, damagePhotoIds: kind === 'damage_claim' ? photoIds(entry.damagePhotoIds) : [], share: shareProjection(entry),
    status: entry.status === 'void' ? 'void' : 'recorded', state: entry.state === 'applied' ? 'applied' : 'pending', needsReview: !valid,
    hasReceipt: Boolean(entry.receipt?.fileId), receiptVerified: entry.receipt?.verified === true, edited: Boolean(entry.editedAt),
  };
  if (!manager) return base;
  const verifiedReceipt = base.receiptVerified && /^[A-Za-z0-9_-]{1,200}$/.test(entry.receipt.fileId || '');
  return {
    ...base, jobId: fieldText(entry.jobId, 180), jobDate: fieldText(entry.jobDate, 10), expectedRevision: entry.__updateTime || '',
    recordedBy: actorLabel(entry.actorId, entry.actorName),
    receiptUrl: verifiedReceipt ? `/api/field-expenses?jobId=${encodeURIComponent(entry.jobId)}&expenseId=${encodeURIComponent(entry.id)}&view=receipt` : null,
    voided: entry.status === 'void' ? { at: fieldText(entry.voidedAt, 40), by: actorLabel(entry.voidedBy, entry.voidedByName), reason: fieldText(entry.voidReason, 500) } : null,
    audit: (Array.isArray(entry.audit) ? entry.audit : []).slice(-AUDIT_LIMIT).map(item => ({ action: item?.action === 'void' ? 'void' : 'edit', at: fieldText(item?.at, 40), by: actorLabel(item?.actorId, item?.actorName), reason: fieldText(item?.reason, 500), before: auditValues(item?.before), after: auditValues(item?.after) })),
    canEdit: entry.state === 'applied' && entry.status !== 'void', canVoid: entry.status !== 'void',
  };
}

// The closeout is derived from every row on the job, not only the viewer's
// own, but crew see only its states and counts, never other people's amounts.
// Managers also get the job-costing view (costs), which carries every amount.
export function fieldExpenseListing(jobId, rows, { manager = false, user = '', attestations = [], closeoutRequired = false } = {}) {
  const self = assignmentKey(user);
  const visible = (manager ? [...rows] : rows.filter(row => self && assignmentKey(row.actorId) === self)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(a.id).localeCompare(String(b.id)));
  return { jobId, scope: manager ? 'job' : 'own', entries: visible.map(row => fieldExpenseProjection(row, { manager })), totals: summarizeFieldExpenses(visible), closeout: closeoutProjection(fieldExpenseCloseout(rows, attestations), { manager, user, required: closeoutRequired }), ...(manager ? { costs: fieldExpenseCosts(rows, attestations) } : {}) };
}

export function fieldExpenseCapacity(rows, { manager = false, user = '', receipt = false } = {}) {
  if (rows.length >= FIELD_EXPENSE_STORED_LIMIT) throw fieldFailure('This job has reached its stored cost-record limit. Ask the owner to review its voided entries.', 409, 'FIELD_EXPENSE_LIMIT');
  const active = rows.filter(row => row.status !== 'void'), limit = manager ? FIELD_EXPENSE_MANAGER_JOB_LIMIT : FIELD_EXPENSE_JOB_LIMIT;
  if (active.length >= limit) throw fieldFailure(`This job already has ${limit} active cost entries. ${manager ? 'Void duplicates before recording more.' : 'Ask operations to review them.'}`, 409, 'FIELD_EXPENSE_LIMIT');
  const self = assignmentKey(user);
  if (receipt && active.filter(row => row.state !== 'applied' && self && assignmentKey(row.actorId) === self).length >= FIELD_EXPENSE_PENDING_LIMIT) throw fieldFailure(`You have ${FIELD_EXPENSE_PENDING_LIMIT} costs whose receipts were not confirmed. Retry those entries or ask operations to void them before adding another receipt.`, 409, 'FIELD_EXPENSE_PENDING_LIMIT');
}

export function fieldExpenseRecord(job, actor, input, fingerprint, now) {
  const values = fieldExpenseValues(input, { damagePhotos: fieldExpenseDamagePhotos(job).map(photo => photo.id.toLowerCase()) });
  return { id: input.requestId.toLowerCase(), jobId: job.id, jobDate: fieldText(job.date, 10), ...values, currency: 'USD', actorId: actor.user, actorName: actor.displayName || actor.user, createdAt: now, incurredOn: fieldExpenseDate(now), status: 'recorded', fingerprint, audit: [], updatedAt: now };
}

// On a row of a shared load an amount correction is the new load total: it is
// split again with the stored weights and this row takes its own part, so the
// same input applied to every row of the load keeps the parts summing to it.
export function fieldExpenseChange(expense, actor, input, fingerprint, now, { damagePhotos = null } = {}) {
  if (!actor.manager) throw fieldFailure('Only operations managers can correct or void recorded field costs.', 403, 'FIELD_EXPENSE_MANAGER_REQUIRED');
  if (typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.length > 500) throw fieldFailure('Give a reason for the correction (3–500 characters). It is kept in the audit trail.', 400, 'FIELD_EXPENSE_REASON_INVALID');
  if (expense.status === 'void') throw fieldFailure('This cost is already void. Record a new cost if it was voided by mistake.', 409, 'FIELD_EXPENSE_VOID');
  const audit = Array.isArray(expense.audit) ? expense.audit : [];
  if (audit.length >= AUDIT_LIMIT) throw fieldFailure('This cost has reached its correction limit. Void it and record a new cost.', 409, 'FIELD_EXPENSE_AUDIT_FULL');
  const stamp = { requestId: input.requestId.toLowerCase(), fingerprint, at: now, actorId: actor.user, actorName: actor.displayName || actor.user, reason: input.reason.trim() };
  if (input.action === 'void') return { status: 'void', voidedAt: now, voidedBy: actor.user, voidedByName: stamp.actorName, voidReason: stamp.reason, updatedAt: now, audit: [...audit, { ...stamp, action: 'void', before: { status: 'recorded' }, after: { status: 'void' } }] };
  if (expense.state !== 'applied') throw fieldFailure('This cost is still waiting for its receipt to be verified. Void it instead, or ask the crew member to retry the upload.', 409, 'FIELD_EXPENSE_PENDING');
  const share = validFieldExpenseShare(expense.share) ? expense.share : null;
  if (share && input.kind !== undefined && !FIELD_EXPENSE_SHAREABLE_KINDS.includes(input.kind)) throw fieldFailure('A damage claim belongs to one job. Void this shared load and record the claim on its job.', 400, 'FIELD_EXPENSE_SHARE_INVALID');
  const values = fieldExpenseValues({ ...input, currentKind: expense.kind, currentNote: expense.note, currentPayer: expense.payer ?? null, currentDamagePhotoIds: expense.damagePhotoIds }, { partial: true, damagePhotos });
  let nextShare = null;
  if (share && 'amountCents' in values) {
    if (values.amountCents === share.totalCents) delete values.amountCents;
    else {
      const cents = splitSharedCents(values.amountCents, share.parts), index = share.parts.findIndex(part => part.jobId === expense.jobId && part.expenseId === expense.id);
      if (index < 0) throw fieldFailure('This shared load is incomplete. Contact the owner before correcting it.', 409, 'FIELD_EXPENSE_SHARE_INCOMPLETE');
      nextShare = { ...share, totalCents: values.amountCents, parts: share.parts.map((part, at) => ({ ...part, amountCents: cents[at] })) };
      values.amountCents = cents[index];
    }
  }
  if (input.incurredOn !== undefined) {
    const today = fieldExpenseDate(now);
    if (!validExpenseDate(input.incurredOn) || input.incurredOn > today || dayNumber(today) - dayNumber(input.incurredOn) > 366) throw fieldFailure('Choose the purchase date within the last year.', 400, 'FIELD_EXPENSE_DATE_INVALID');
    values.incurredOn = input.incurredOn;
  }
  const current = key => key === 'payer' ? expense.payer ?? null : key === 'damagePhotoIds' ? photoIds(expense.damagePhotoIds) : expense[key];
  const before = {}, after = {};
  for (const key of EDITABLE) if (key in values && !sameValue(values[key], current(key))) { before[key] = current(key) ?? null; after[key] = values[key]; }
  const changed = { ...after };
  if (nextShare) { before.loadTotalCents = share.totalCents; after.loadTotalCents = nextShare.totalCents; changed.share = nextShare; }
  if (!Object.keys(after).length) throw fieldFailure('Change at least one value before saving the correction.', 400, 'FIELD_EXPENSE_NO_CHANGE');
  return { ...changed, editedAt: now, editedBy: actor.user, updatedAt: now, audit: [...audit, { ...stamp, action: 'edit', before, after }] };
}

// "None" for one closeout kind, written create-only at
// jobs/{jobId}/fieldExpenseCloseout/{kind}.
export function fieldExpenseAttestation(kind, actor, requestId, fingerprint, now) {
  return { kind, group: closeoutGroup(kind).id, attestation: 'none', requestId: requestId.toLowerCase(), fingerprint, actorId: actor.user, actorName: actor.displayName || actor.user, at: now };
}

const decode = (document, jobId) => {
  const match = /\/documents\/jobs\/([^/]+)\/fieldExpenses\/([^/]+)$/.exec(document?.name || '');
  if (!match || !document.fields || !fieldId(match[1]) || !fieldRequestId(match[2]) || (jobId && match[1] !== jobId)) return null;
  // Path identity wins over stored fields so a copied row cannot move jobs.
  return { ...decodeFirestoreFields(document.fields), id: match[2], jobId: match[1], __updateTime: document.updateTime || '' };
};
const decodeRequest = (document, jobId, id) => {
  const match = /\/documents\/jobs\/([^/]+)\/fieldExpenseRequests\/([^/]+)$/.exec(document?.name || '');
  if (!match || !document.fields || match[1] !== jobId || match[2] !== id) return null;
  return { ...decodeFirestoreFields(document.fields), id, jobId };
};
const decodeAttestation = (document, jobId) => {
  const match = /\/documents\/jobs\/([^/]+)\/fieldExpenseCloseout\/([^/]+)$/.exec(document?.name || '');
  if (!match || !document.fields || match[1] !== jobId || !CLOSEOUT_KINDS.includes(match[2])) return null;
  return { ...decodeFirestoreFields(document.fields), kind: match[2], group: closeoutGroup(match[2]).id, jobId, __updateTime: document.updateTime || '' };
};
const unavailable = () => fieldFailure('Job-cost storage is unavailable. Retry when connected.', 503, 'FIELD_STORAGE_UNAVAILABLE');
const incomplete = () => fieldFailure('Job-cost storage returned an incomplete answer. Retry.', 503, 'FIELD_EXPENSE_STORAGE_INCOMPLETE');
const jobChanged = () => fieldFailure('This job changed while the cost was being confirmed. Retry the same entry to check it again.', 409, 'FIELD_REVISION_CONFLICT');

export function createFieldExpenseStore(env, fetcher = firestoreFetch) {
  const send = async (url, options) => { try { return await fetcher(env, url, options); } catch { throw unavailable(); } };
  const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  async function query(parent, structuredQuery, decoder) {
    const response = await send(`${BASE}${parent ? `/${parent}` : ''}:runQuery`, json({ structuredQuery }));
    if (!response.ok) {
      const detail = JSON.stringify(await response.json().catch(() => ({})));
      if (response.status === 400 && /FAILED_PRECONDITION/.test(detail)) throw fieldFailure('Job-cost reporting is waiting for its storage index. Ask the owner to finish the field-cost setup.', 503, 'FIELD_EXPENSE_INDEX_REQUIRED');
      throw unavailable();
    }
    const rows = await response.json().catch(() => null);
    if (!Array.isArray(rows)) throw incomplete();
    return rows.filter(row => row?.document).map(row => decoder(row.document)).filter(Boolean);
  }
  async function commit(writes, conflict, transaction = '') {
    const response = await send(`${BASE}:commit`, json({ ...(transaction ? { transaction } : {}), writes }));
    if (!response.ok && commitConflict(await commitFailure(response))) throw conflict();
    if (!response.ok) throw fieldFailure('The cost could not be confirmed. Retry with the same entry to check its result.', 503, 'FIELD_STORAGE_UNAVAILABLE');
  }
  // The public REST Write has no read-only verify operation (see
  // dispatch-storage.js), so a read-write transaction that reads the jobs
  // fences the cost writes against the job revisions whose assignment was just
  // checked, without writing any job document. A concurrent job change aborts.
  async function fenced(guards, writes, conflict) {
    const started = await send(`${BASE}:beginTransaction`, json({ options: { readWrite: {} } }));
    if (!started.ok) throw unavailable();
    const transaction = (await started.json().catch(() => ({})))?.transaction;
    if (typeof transaction !== 'string' || !transaction) throw incomplete();
    let committed = false;
    try {
      const result = await send(`${BASE}:batchGet`, json({ documents: guards.map(guard => `${ROOT}/jobs/${guard.jobId}`), mask: { fieldPaths: ['type'] }, transaction }));
      if (result.status === 409 || result.status === 412) throw jobChanged();
      if (!result.ok) throw unavailable();
      const rows = await result.json().catch(() => null);
      if (!Array.isArray(rows)) throw incomplete();
      for (const guard of guards) {
        const found = rows.find(row => row?.found?.name === `${ROOT}/jobs/${guard.jobId}`)?.found;
        if (!found || found.updateTime !== guard.revision) throw jobChanged();
      }
      await commit(writes, conflict, transaction); committed = true;
    } finally { if (!committed) await send(`${BASE}:rollback`, json({ transaction })).catch(() => null); }
  }
  const createWrite = row => ({ update: { name: `${ROOT}/jobs/${row.jobId}/fieldExpenses/${row.id}`, fields: encodeFirestoreFields(row) }, currentDocument: { exists: false } });
  const requestWrite = (jobId, request) => ({ update: { name: `${ROOT}/jobs/${jobId}/fieldExpenseRequests/${request.id}`, fields: encodeFirestoreFields(request) }, currentDocument: { exists: false } });
  const started = () => fieldFailure('This cost entry was already started. Retry to check its result.', 409, 'FIELD_EXPENSE_CONFLICT');
  const jobs = createFieldStore(env);
  return {
    readJob: id => jobs.readJob(id),
    listDays: (start, end) => jobs.listDays(start, end),
    async readRequest(jobId, id) {
      const response = await send(`${BASE}/jobs/${jobId}/fieldExpenseRequests/${id}`);
      if (response.status === 404) return null;
      if (!response.ok) throw unavailable();
      const row = decodeRequest(await response.json().catch(() => null), jobId, id);
      if (!row) throw fieldFailure('Job-cost storage returned an unverifiable correction record. Retry.', 503, 'FIELD_EXPENSE_STORAGE_INCOMPLETE');
      return row;
    },
    // Current schedule dates for the date-range report: one masked batchGet per
    // 100 jobs rather than one read per job.
    async jobSchedules(ids) {
      const valid = [...new Set(ids)].filter(fieldId), chunks = [];
      for (let index = 0; index < valid.length; index += 100) chunks.push(valid.slice(index, index + 100));
      const found = new Map();
      await Promise.all(chunks.map(async chunk => {
        const response = await send(`${BASE}:batchGet`, json({ documents: chunk.map(id => `${ROOT}/jobs/${id}`), mask: { fieldPaths: ['date', 'endDate'] } }));
        if (!response.ok) throw unavailable();
        const rows = await response.json().catch(() => null);
        if (!Array.isArray(rows)) throw incomplete();
        for (const row of rows) {
          const id = /\/documents\/jobs\/([^/]+)$/.exec(row?.found?.name || '')?.[1];
          if (!id || !chunk.includes(id)) continue;
          const value = decodeFirestoreFields(row.found.fields || {});
          found.set(id, { date: validExpenseDate(value.date) ? value.date : '', endDate: validExpenseDate(value.endDate) ? value.endDate : '' });
        }
      }));
      return found;
    },
    async readExpense(jobId, id) {
      const response = await send(`${BASE}/jobs/${jobId}/fieldExpenses/${id}`);
      if (response.status === 404) return null;
      if (!response.ok) throw unavailable();
      const row = decode(await response.json().catch(() => null), jobId);
      if (!row || row.id !== id) throw fieldFailure('Job-cost storage returned an unverifiable record. Retry.', 503, 'FIELD_EXPENSE_STORAGE_INCOMPLETE');
      return row;
    },
    async listExpenses(jobId) {
      const rows = await query(`jobs/${jobId}`, { from: [{ collectionId: 'fieldExpenses' }], limit: LIST_LIMIT + 1 }, document => decode(document, jobId));
      if (rows.length > LIST_LIMIT) throw fieldFailure('This job has more cost records than can be verified at once. Contact operations.', 503, 'FIELD_EXPENSE_STORAGE_INCOMPLETE');
      return rows;
    },
    listAttestations: jobId => query(`jobs/${jobId}`, { from: [{ collectionId: 'fieldExpenseCloseout' }], limit: CLOSEOUT_KINDS.length + 5 }, document => decodeAttestation(document, jobId)),
    async listRange(start, end) {
      const range = (op, value) => ({ fieldFilter: { field: { fieldPath: 'incurredOn' }, op, value: { stringValue: value } } });
      const rows = await query('', { from: [{ collectionId: 'fieldExpenses', allDescendants: true }], where: { compositeFilter: { op: 'AND', filters: [range('GREATER_THAN_OR_EQUAL', start), range('LESS_THAN_OR_EQUAL', end)] } }, limit: RANGE_LIMIT + 1 }, document => decode(document));
      if (rows.length > RANGE_LIMIT) throw fieldFailure('This date range has too many cost records to total at once. Choose a shorter range.', 400, 'FIELD_EXPENSE_RANGE_TOO_LARGE');
      return rows;
    },
    create: (jobId, record) => commit([createWrite({ ...record, jobId })], started),
    // Every row of a shared load in one commit: all of them or none.
    createMany: rows => commit(rows.map(createWrite), started),
    // One create-only "None" per kind; an empty list writes only the request
    // receipt (every kind was already entered or marked "None").
    attest: (jobId, attestations, request) => commit([
      ...attestations.map(attestation => ({ update: { name: `${ROOT}/jobs/${jobId}/fieldExpenseCloseout/${attestation.kind}`, fields: encodeFirestoreFields(attestation) }, currentDocument: { exists: false } })),
      requestWrite(jobId, request),
    ], () => fieldFailure('The closeout changed while it was being saved. Retry to check it.', 409, 'FIELD_EXPENSE_CLOSEOUT_CONFLICT')),
    // request: a correction receipt written with exists:false in the same
    // commit. jobRevision and fences [{jobId, revision}]: fence the writes
    // against those job revisions. related [{jobId, expense, patch}]: the other
    // rows of a shared load, each under its own revision precondition.
    update(jobId, expense, patch, { request = null, jobRevision = '', related = [], fences = [] } = {}) {
      const write = (id, row, value) => {
        if (!row.__updateTime) throw fieldFailure('The cost version is unavailable. Refresh before changing it.', 409, 'FIELD_EXPENSE_REVISION_CONFLICT');
        return { update: { name: `${ROOT}/jobs/${id}/fieldExpenses/${row.id}`, fields: encodeFirestoreFields(value) }, updateMask: { fieldPaths: Object.keys(value) }, currentDocument: { updateTime: row.__updateTime } };
      };
      const writes = [write(jobId, expense, patch), ...related.map(item => write(item.jobId, item.expense, item.patch))];
      if (request) writes.push(requestWrite(jobId, request));
      const conflict = () => fieldFailure('This cost changed while you were working. Refresh to review it, then retry.', 409, 'FIELD_EXPENSE_REVISION_CONFLICT');
      const guards = [...(jobRevision ? [{ jobId, revision: jobRevision }] : []), ...fences];
      return guards.length ? fenced(guards, writes, conflict) : commit(writes, conflict);
    },
  };
}

/**
 * Totals the field costs recorded on one job for the job-costing dashboard.
 * Server-side only. NOTE the argument order: the Pages Functions env comes
 * first, then the job ID (the unit spec's sumFieldExpenses(jobId) shorthand
 * omitted env).
 *
 * @param {object} env Pages Functions env (Firestore service account).
 * @param {string} jobId jobs/{jobId} document ID.
 * @param {{ store?: { listExpenses(jobId: string): Promise<object[]> } }} [options]
 *   Injected storage; defaults to createFieldExpenseStore(env).
 * @returns {Promise<{ jobId: string, currency: 'USD', totalCents: number,
 *   costCents: number, recoveryIncomeCents: number,
 *   byKind: { material: number, dump_fee: number, subcontractor: number,
 *     fuel: number, damage_claim: number, other: number,
 *     recovery_income: number },
 *   byPayer: { company_card: number, crew_reimbursable: number,
 *     account_billed: number, unspecified: number },
 *   count: number, voidCount: number, pendingCount: number,
 *   invalidCount: number, receiptCount: number, sharedCount: number,
 *   complete: boolean }>}
 *   Integer cents of verified, non-void entries. totalCents is costCents minus
 *   recoveryIncomeCents (recovery_income is money received). byPayer covers
 *   cost kinds only; legacy rows without a payer are 'unspecified'. A shared
 *   load counts only this job's part. complete is false while any receipt is
 *   unverified or a stored row is unreadable; never treat that as a final zero.
 * @throws 400 FIELD_REQUEST_INVALID for an invalid job ID; 503 storage codes.
 */
export async function sumFieldExpenses(env, jobId, { store } = {}) {
  if (typeof env === 'string' || !env || typeof env !== 'object') throw new TypeError('sumFieldExpenses(env, jobId, { store }) takes the Pages env first.');
  if (!fieldId(jobId)) throw fieldFailure('Choose a valid job.');
  return { jobId, ...summarizeFieldExpenses(await (store || createFieldExpenseStore(env)).listExpenses(jobId)) };
}

/**
 * The job's closeout for job costing, derived from its cost rows and per-kind
 * "None" attestations: kinds { material, dump_fee, subcontractor, fuel,
 * damage_claim, other: 'entered'|'none'|'missing' }, groups [{ id, required,
 * state: 'entered'|'none'|'missing', confirmed, openKinds, entryCount,
 * pendingCount, attestedAt, attestedBy }], plus complete (every required group
 * confirmed), confirmed (every group, optional ones included) and missing
 * (unconfirmed required group IDs). A kind's "None" is a known zero only while
 * its state is 'none'.
 */
export async function fieldExpenseCloseoutStatus(env, jobId, { store } = {}) {
  if (!fieldId(jobId)) throw fieldFailure('Choose a valid job.');
  const source = store || createFieldExpenseStore(env);
  const [rows, attestations] = await Promise.all([source.listExpenses(jobId), source.listAttestations(jobId)]);
  const closeout = fieldExpenseCloseout(rows, attestations);
  return { jobId, complete: closeout.complete, confirmed: closeout.confirmed, missing: closeout.missing, kinds: closeout.kinds, groups: closeout.groups.map(({ attestation, ...group }) => ({ ...group, attestedAt: attestation?.at || null, attestedBy: attestation?.actorId || null })) };
}

/**
 * The job's field costs for job costing (FUN-21), server-side only; env comes
 * first. Returns { jobId, currency, status: 'complete'|'partial'|'unknown',
 * netCostCents (null while unknown), knownCostCents, recoveryIncomeCents,
 * reimbursableCents, byPayer, components: { materials, disposal, subcontract,
 * fuel, damageClaims, other, recoveryIncome } each { cents|null, status,
 * basis: 'recorded'|'attested_none'|'closeout_unconfirmed', group, openCount },
 * missing (IDs of groups with an unconfirmed kind), coverage }. Unknown until
 * every closeout kind is entered or "None"; partial while receipts are pending
 * or a row is unreadable. A shared load counts only this job's part, and
 * crew_reimbursable costs must never also be counted as labor.
 */
export async function fieldExpenseJobCosts(env, jobId, { store } = {}) {
  if (!fieldId(jobId)) throw fieldFailure('Choose a valid job.');
  const source = store || createFieldExpenseStore(env);
  const [rows, attestations] = await Promise.all([source.listExpenses(jobId), source.listAttestations(jobId)]);
  return { jobId, ...fieldExpenseCosts(rows, attestations) };
}

// Completion text for required groups that are still missing. Empty unless
// FIELD_EXPENSE_CLOSEOUT_REQUIRED is on (no storage reads when it is off).
// safe: report an unreadable closeout as one item instead of throwing.
export async function fieldExpenseCloseoutMissing(env, jobId, { store, safe = false } = {}) {
  if (!fieldExpenseCloseoutRequired(env)) return [];
  try { return (await fieldExpenseCloseoutStatus(env, jobId, { store })).missing.map(id => CLOSEOUT_MISSING[id]); }
  catch (error) { if (safe) return ['Job costs could not be checked. Refresh the job before completing it.']; throw error; }
}

// The completion gate: with the flag on, a job completes only after each
// required closeout group is entered or "None". Missing items are reported
// together with the other completion requirements.
export async function requireFieldExpenseCloseout(env, job, input, { store } = {}) {
  // A closed job keeps its own answer (FIELD_JOB_CLOSED from the field command).
  if (['completed', 'invoiced', 'paid', 'review_requested'].includes(fieldStage(job)) || fieldCancelled(job)) return;
  const missing = await fieldExpenseCloseoutMissing(env, job.id, { store });
  if (missing.length) throw fieldFailure('Finish the required closeout items.', 409, 'FIELD_COMPLETION_INCOMPLETE', { missing: [...fieldCompletionMissing(job, input), ...missing] });
}

// Inclusive range: start and end are both counted, so 92 days is Jul 1–Sep 30.
export function fieldExpenseRangeValid(start, end) {
  return validExpenseDate(start) && validExpenseDate(end) && start <= end && dayNumber(end) - dayNumber(start) + 1 <= FIELD_EXPENSE_RANGE_DAYS;
}

/**
 * Per-job field-cost totals for purchases whose Mountain incurredOn date is in
 * [start, end] (both included, at most FIELD_EXPENSE_RANGE_DAYS days).
 * jobDates come from the job's current schedule (jobDatesBasis 'current');
 * when the job is gone or its schedule cannot be read they fall back to the
 * dates recorded with each cost (jobDatesBasis 'recorded').
 */
export async function fieldExpenseRange(env, { start, end }, { store = createFieldExpenseStore(env) } = {}) {
  if (!fieldExpenseRangeValid(start, end)) throw fieldFailure(`Choose a start and end date covering at most ${FIELD_EXPENSE_RANGE_DAYS} days, both dates included.`, 400, 'FIELD_EXPENSE_RANGE_INVALID');
  const rows = await store.listRange(start, end), groups = new Map();
  for (const row of rows) { if (!groups.has(row.jobId)) groups.set(row.jobId, []); groups.get(row.jobId).push(row); }
  let schedules = null;
  if (groups.size && typeof store.jobSchedules === 'function') { try { schedules = await store.jobSchedules([...groups.keys()]); } catch { schedules = null; } }
  const jobs = [...groups].map(([jobId, entries]) => {
    const current = schedules?.get(jobId), dates = current?.date ? [current.date, current.endDate].filter(Boolean) : entries.map(entry => fieldText(entry.jobDate, 10)).filter(validExpenseDate);
    return { jobId, jobDates: [...new Set(dates)].sort(), jobDatesBasis: current?.date ? 'current' : 'recorded', ...summarizeFieldExpenses(entries) };
  }).sort((a, b) => (a.jobDates[0] || '').localeCompare(b.jobDates[0] || '') || a.jobId.localeCompare(b.jobId));
  return { start, end, basis: 'incurredOn', timezone: 'America/Denver', jobs, totals: summarizeFieldExpenses(rows) };
}
