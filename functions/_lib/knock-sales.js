// Sales from the door. A sale needs the signed checklist, a job date after the cancellation window
// and the customer's contact details, which live only on knock_sales (never on houses or events).
// Admins move a sale through booked, cancelled, completed and paid.
import { knockFailure, write } from './knock-store.js';
import { PACKAGES, SALE_STATUSES } from '../../crew/knock-settings.js';
import { cancellationWindow, dayPartOf, defaultJobStart, depositAmount, jobStartAllowed, jobStartFloor, saleDateOf } from '../../crew/knock-sale-rules.js';
import { validDate } from '../../crew/knock-time.js';
import { snapshotCommissionTerms } from '../../crew/knock-money.js';
import { nativeHouseClaimId, nativeClaimActive } from './knock-form-claims.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ZIP = /^\d{5}$/;
const refuse = (code, error) => ({ status: 'rejected', code, error });
const START_TOO_EARLY = 'Jobs start at 9:30 am or later. Pick a later start time.';

/* A native walkthrough-request claim blocks a direct sale on the house, except (KNOCK-BRIDGE, EGC_KNOCK_JOB_BRIDGE)
   when the same rep who asked for the walkthrough now closes the sale at the door. */
export function saleClaimConflict(claim, rep, { jobBridge = false } = {}) {
  if (!nativeClaimActive(claim)) return false;
  if (claim.channel === 'direct_sale' && claim.repKey === rep.repKey) return false;
  return !(jobBridge && claim.channel === 'walkthrough_request' && claim.repKey === rep.repKey);
}

// US phone numbers to E.164 (+1XXXXXXXXXX); anything else is refused.
export function normalizePhone(value) {
  const digits = String(value || '').replace(/[^\d]/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return '';
  return `+1${ten}`;
}

export function checklistComplete(settings, checklist) {
  return (settings.sale.checklist || []).every(item => checklist?.[item.key] === true);
}

/* Validate a sale event against the rep's door. Returns a rejection or null. */
export async function validateSaleEvent(store, rep, settings, event, { accepted = [], targets = new Map(), houses = new Map(), jobBridge = false } = {}) {
  if (!UUID.test(String(event.knockId || ''))) return refuse('knock_sale_invalid', 'The sale is missing its door.');
  const knock = accepted.find(a => a.id === event.knockId) || targets.get(event.knockId) || await store.get('knock_events', event.knockId);
  if (!knock || knock.type !== 'knock' || knock.outcome !== 'sold' || knock.repKey !== rep.repKey) return refuse('knock_sale_invalid', 'Log the door as Sold first.');
  if (event.houseId && event.houseId !== knock.houseId) return refuse('knock_sale_invalid', 'The sale and the door are different houses.');
  const claim = await store.get('knock_receipts', await nativeHouseClaimId(knock.houseId));
  if (saleClaimConflict(claim, rep, { jobBridge }))
    return refuse('knock_form_channel_conflict', 'This house has a different form channel or rep. Review attribution before saving a direct sale.');
  const existing = await store.query('knock_sales', { where: [['knockId', '==', knock.id]], limit: 1 });
  if (existing.length || accepted.some(a => a.type === 'sale' && a.knockId === knock.id)) return refuse('knock_sale_exists', 'That door already has a sale.');
  const ticket = Number(event.ticket);
  if (!Number.isFinite(ticket) || ticket <= 0 || ticket > 100000) return refuse('knock_sale_ticket', 'Enter the ticket price.');
  if (!PACKAGES.includes(event.package)) return refuse('knock_sale_package', 'Pick a package.');
  const name = String(event.customer?.name || '').trim();
  if (!name || name.length > 80) return refuse('knock_sale_customer', 'Enter the customer\'s name.');
  if (!normalizePhone(event.customer?.phone)) return refuse('knock_sale_customer', 'Enter a 10-digit US phone number.');
  if (!EMAIL.test(String(event.customer?.email || '').trim())) return refuse('knock_sale_customer', 'Enter the customer\'s email (the contract is emailed there).');
  if (!checklistComplete(settings, event.checklist)) return refuse('knock_sale_checklist', 'Tick every item on the sale checklist.');
  if (typeof event.textConsent !== 'boolean') return refuse('knock_sale_invalid', 'Say whether the customer agreed to a text.');
  const window = cancellationWindow(saleDateOf(event.at), { businessDays: settings.sale.cancelBusinessDays, extraHolidays: settings.sale.extraHolidays });
  if (!validDate(event.jobDate) || event.jobDate < window.earliestJobDate) return refuse('knock_sale_job_date', `The job date must be ${window.earliestJobDate} or later (after the cancellation deadline).`);
  if (event.jobStartTime != null && !TIME.test(String(event.jobStartTime))) return refuse('knock_sale_invalid', 'Job start time must be HH:MM.');
  // KNOCK-BRIDGE: the town and ZIP the Hub customer and job need, the rep's slot or morning/afternoon choice, and a
  // start at 9:30 or later (the Hub books no job earlier; the phone's Edit and resend keeps everything else typed).
  // With the bridge off an explicit start is stored as sent, as before (the office books those jobs by hand).
  if (jobBridge) {
    if (event.jobStartTime != null && !jobStartAllowed(event.jobDate, event.jobStartTime)) return refuse('knock_sale_job_time', START_TOO_EARLY);
    if (event.zip != null && event.zip !== '' && !ZIP.test(String(event.zip))) return refuse('knock_sale_zip', 'Enter the 5-digit ZIP code.');
    if (event.city != null && (typeof event.city !== 'string' || event.city.length > 60)) return refuse('knock_sale_invalid', 'Town must be at most 60 characters.');
    if (event.dayPart != null && !['am', 'pm'].includes(event.dayPart)) return refuse('knock_sale_invalid', 'Choose morning or afternoon.');
    if (event.slot != null && (typeof event.slot !== 'object' || Array.isArray(event.slot) || event.slot.date !== event.jobDate || event.slot.time !== event.jobStartTime ||
      (event.slot.crewLabel != null && (typeof event.slot.crewLabel !== 'string' || event.slot.crewLabel.length > 100)))) return refuse('knock_sale_invalid', 'The picked crew slot does not match the job date and time.');
  }
  if (event.quotedAmount != null && !(Number(event.quotedAmount) >= 0)) return refuse('knock_sale_invalid', 'Quoted amount must be a number.');
  if (event.note != null && String(event.note).length > 500) return refuse('knock_sale_invalid', 'Note is too long.');
  const house = houses.get(knock.houseId) || await store.get('knock_houses', knock.houseId);
  if (!house) return refuse('knock_house_missing', 'That house is not in canvassing.');
  houses.set(knock.houseId, house);
  return null;
}

/* The sale record. Returns the writes for the sync commit (the caller has validated it). */
export async function applySaleEvent(store, rep, settings, event, nowIso, { houses = new Map(), jobBridge = false, cityName = '' } = {}) {
  const knock = await store.get('knock_events', event.knockId).catch(() => null);
  const houseId = event.houseId || knock?.houseId;
  const house = houses.get(houseId) || await store.get('knock_houses', houseId);
  const saleDate = saleDateOf(event.at);
  const window = cancellationWindow(saleDate, { businessDays: settings.sale.cancelBusinessDays, extraHolidays: settings.sale.extraHolidays });
  const ticket = Math.round(Number(event.ticket) * 100) / 100;
  const sale = {
    repKey: rep.repKey, leadKey: rep.leadKey || '', knockId: event.knockId, houseId,
    neighborhoodId: house?.neighborhoodId || '', street: house?.street || '',
    address: { number: house?.number || '', street: house?.street || '', unit: house?.unit || '',
      // KNOCK-BRIDGE: the town (the neighborhood's, unless the rep corrected it) and ZIP for the Hub customer and job.
      ...(jobBridge ? { city: String(event.city || cityName || '').trim().slice(0, 60), state: 'CO', zip: ZIP.test(String(event.zip || '')) ? String(event.zip) : '' } : {}) },
    customer: { name: String(event.customer.name).trim(), phone: normalizePhone(event.customer.phone), email: String(event.customer.email).trim().toLowerCase() },
    textConsent: event.textConsent === true,
    ticket, package: event.package, quotedAmount: event.quotedAmount != null ? Number(event.quotedAmount) : null,
    commissionTerms: snapshotCommissionTerms(settings.commission, event.at, event.package),
    depositRate: settings.sale.depositRate, depositAmount: depositAmount(ticket, settings.sale.depositRate),
    soldAt: event.at, saleDate, cancelDeadlineDate: window.deadlineDate, cancelEndsAt: new Date(window.cancelEndsAt).toISOString(),
    earliestJobDate: window.earliestJobDate, jobDate: event.jobDate, jobStartTime: event.jobStartTime || defaultJobStart(settings, event.jobDate),
    refundCutoffHours: settings.sale.refundCutoffHours,
    checklist: Object.fromEntries((settings.sale.checklist || []).map(item => [item.key, true])), checklistConfirmedAt: event.at,
    note: event.note ? String(event.note).slice(0, 500) : '',
    status: 'booked', statusHistory: [{ status: 'booked', at: event.at, by: rep.repKey }],
    completedAt: null, paidAt: null, cancelledAt: null, collectedAmount: null,
    // KNOCK-BRIDGE: what the rep picked (a crew slot, or a date and morning/afternoon while offline). The server
    // books the Hub job from it after the sale syncs (knock-bridge.js); the slot is a suggestion, never a promise.
    ...(jobBridge ? { schedule: event.slot ? { source: 'slot', date: event.slot.date, time: event.slot.time, crewLabel: String(event.slot.crewLabel || '').slice(0, 100), part: dayPartOf(event.slot.time) }
      : { source: 'preference', date: event.jobDate, time: event.jobStartTime || defaultJobStart(settings, event.jobDate), crewLabel: '', part: event.dayPart || dayPartOf(event.jobStartTime || defaultJobStart(settings, event.jobDate)) } } : {}),
    handoff: {
      job: jobBridge ? { mode: 'hub', status: 'pending', ref: '', at: null, by: '' } : { mode: settings.integrations.job, status: 'pending', ref: '', at: null, by: '' },
      deposit: { mode: settings.integrations.deposit, status: 'pending', url: '', sessionId: '', amount: depositAmount(ticket, settings.sale.depositRate), collectedAt: null, by: '' },
      text: { mode: settings.integrations.text, status: event.textConsent ? 'pending' : 'no_consent', sentAt: null, messageId: '', error: '', by: '' },
    },
    createdAt: nowIso, updatedAt: nowIso,
  };
  return [write.create('knock_sales', event.id, sale)];
}

/* What a rep sees of their own sales; admins get the whole record. */
export function repSaleView(sale) {
  const { __updateTime, ...rest } = sale;
  return rest;
}

export async function repSales(store, repKey) {
  const rows = await store.query('knock_sales', { where: [['repKey', '==', repKey]] });
  return rows.map(repSaleView).sort((a, b) => String(b.soldAt).localeCompare(String(a.soldAt)));
}

export async function allSales(store, { from = '', to = '' } = {}) {
  const rows = await store.list('knock_sales');
  return rows.filter(s => (!from || s.saleDate >= from) && (!to || s.saleDate <= to)).map(repSaleView)
    .sort((a, b) => String(b.soldAt).localeCompare(String(a.soldAt)));
}

const TRANSITIONS = {
  booked: ['cancelled', 'completed', 'paid'],
  completed: ['paid', 'cancelled', 'booked'],
  paid: ['cancelled', 'completed'],
  cancelled: ['booked'],
};

/* Job status and customer receipts are independent facts. Reopening or cancelling
   never erases money already recorded, and collecting money never completes work. */
export async function setSaleStatus(store, admin, { saleId, status, collectedAmount, note }, nowIso) {
  if (!SALE_STATUSES.includes(status)) throw knockFailure('Unknown sale status.', 400, 'knock_invalid_status');
  const sale = await store.get('knock_sales', String(saleId || ''));
  if (!sale) throw knockFailure('That sale was not found.', 404, 'knock_sale_missing');
  if (sale.status === status) return { sale: repSaleView(sale) };
  if (!TRANSITIONS[sale.status]?.includes(status)) throw knockFailure(`A ${sale.status} sale cannot become ${status}.`, 409, 'knock_invalid_transition');
  const patch = { status, updatedAt: nowIso, statusHistory: [...(sale.statusHistory || []), { status, at: nowIso, by: admin.user, ...(note ? { note: String(note).slice(0, 200) } : {}) }] };
  if (status === 'cancelled') patch.cancelledAt = nowIso;
  if (status === 'booked') { patch.cancelledAt = null; patch.completedAt = null; }
  if (status === 'completed') {
    patch.completedAt = sale.completedAt || nowIso;
    if (sale.paidAt && sale.collectedAmount >= sale.ticket) patch.status = 'paid';
  }
  if (status === 'paid') {
    if (!sale.completedAt) throw knockFailure('Record completion separately. Use customer collection for an advance receipt.', 409, 'knock_completion_required');
    const amount = collectedAmount == null || collectedAmount === '' ? NaN : Number(collectedAmount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) throw knockFailure('Enter the amount collected.', 400, 'knock_invalid_amount');
    if (Math.round(amount * 100) !== Math.round(Number(sale.ticket) * 100)) throw knockFailure('Paid requires the full ticket amount. Record partial customer receipts separately.', 409, 'knock_partial_collection');
    patch.collectedAmount = Math.round(amount * 100) / 100;
    patch.paidAt = nowIso;
  }
  await store.commit([write.patch('knock_sales', sale.id, patch, sale.__updateTime)]);
  return { sale: repSaleView({ ...sale, ...patch }) };
}

// Cumulative customer receipts include the deposit. This records evidence only;
// it does not charge a customer or pay a rep. Identical totals are idempotent.
export async function recordSaleCollection(store, admin, { saleId, collectedAmount }, nowIso) {
  const sale = await store.get('knock_sales', String(saleId || ''));
  if (!sale) throw knockFailure('That sale was not found.', 404, 'knock_sale_missing');
  const amount = collectedAmount == null || collectedAmount === '' ? NaN : Number(collectedAmount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > Number(sale.ticket)) throw knockFailure('Enter the cumulative amount received, up to the ticket total.', 400, 'knock_invalid_amount');
  if (sale.status === 'cancelled') throw knockFailure('Reconcile cancelled receipts with finance.', 409, 'knock_collection_review');
  const value = Math.round(amount * 100) / 100;
  const prior = Number(sale.collectedAmount ?? sale.handoff?.deposit?.collectedAmount ?? 0);
  if (!Number.isFinite(prior) || prior < 0) throw knockFailure('Existing receipt data needs finance review before another entry.', 409, 'knock_collection_review');
  if (value < prior) throw knockFailure('A reduced receipt needs refund review; it cannot overwrite collected money.', 409, 'knock_collection_review');
  if (value === Number(sale.collectedAmount)) return { sale: repSaleView(sale), duplicate: true };
  const patch = { collectedAmount: value, paidAt: nowIso, updatedAt: nowIso,
    collectionHistory: [...(sale.collectionHistory || []), { total: value, previousTotal: prior,
      previousAt: sale.paidAt || sale.handoff?.deposit?.collectedAt || null, at: nowIso, by: admin.user }],
    ...(sale.completedAt && value === Number(sale.ticket) ? { status: 'paid' } : {}) };
  await store.commit([write.patch('knock_sales', sale.id, patch, sale.__updateTime)]);
  return { sale: repSaleView({ ...sale, ...patch }), duplicate: false };
}

/* options (KNOCK-BRIDGE, EGC_KNOCK_JOB_BRIDGE; functions/api/knock-admin.js passes them only while it is on):
   jobBridge: a start before 9:30 on a policy date is refused, and a kept early start is raised to 9:30 and noted;
   moveHub(sale, {jobDate, jobStartTime}): moves the sale's Hub job first (knock-bridge.js moveSaleJob) and answers the
   handoff.job fields saved with the new date, or null for a sale without one; it throws when the Hub refuses, so the
   sale is not moved alone. Without options the change is exactly as before. */
export async function setJobDate(store, admin, { saleId, jobDate, jobStartTime }, nowIso, { jobBridge = false, moveHub = null } = {}) {
  const sale = await store.get('knock_sales', String(saleId || ''));
  if (!sale) throw knockFailure('That sale was not found.', 404, 'knock_sale_missing');
  if (!validDate(jobDate) || jobDate < sale.earliestJobDate) throw knockFailure(`The job date must be ${sale.earliestJobDate} or later (after the cancellation deadline).`, 400, 'knock_sale_job_date');
  if (jobStartTime != null && !TIME.test(String(jobStartTime))) throw knockFailure('Job start time must be HH:MM.', 400, 'knock_invalid_time');
  if (jobBridge && jobStartTime != null && !jobStartAllowed(jobDate, jobStartTime)) throw knockFailure(START_TOO_EARLY, 400, 'knock_sale_job_time');
  // A move that keeps a saved start before 9:30 onto a 9:30-policy date takes the 9:30 start (job-start-policy.js).
  const raised = jobBridge && jobStartTime == null && sale.jobStartTime && !jobStartAllowed(jobDate, sale.jobStartTime) ? jobStartFloor(jobDate) : null;
  const hub = moveHub ? await moveHub(sale, { jobDate, jobStartTime: jobStartTime || raised || null }) : null;
  const start = hub?.time || jobStartTime || raised;
  const patch = { jobDate, ...(start ? { jobStartTime: start } : {}), updatedAt: nowIso,
    ...(hub ? { handoff: { ...(sale.handoff || {}), job: { ...(sale.handoff?.job || {}), ...hub, by: admin.user } } } : {}),
    statusHistory: [...(sale.statusHistory || []), { status: sale.status, at: nowIso, by: admin.user,
      note: `Job date ${jobDate}${raised && !hub ? `, start ${raised} (jobs start at 9:30 or later)` : ''}${hub ? `; Hub job moved to ${hub.date} ${hub.time}${hub.crewLabel ? `, ${hub.crewLabel}` : ''}` : ''}` }] };
  await store.commit([write.patch('knock_sales', sale.id, patch, sale.__updateTime)]);
  return { sale: repSaleView({ ...sale, ...patch }), ...(hub ? { hubJob: { date: hub.date, time: hub.time, crewLabel: hub.crewLabel, assignment: hub.assignment, message: hub.message } } : {}) };
}
