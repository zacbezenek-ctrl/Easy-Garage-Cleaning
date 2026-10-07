// Sales from the door. A sale needs the signed checklist, a job date after the cancellation window
// and the customer's contact details, which live only on knock_sales (never on houses or events).
// Admins move a sale through booked, cancelled, completed and paid.
import { knockFailure, write } from './knock-store.js';
import { PACKAGES, SALE_STATUSES } from '../../crew/knock-settings.js';
import { cancellationWindow, depositAmount, saleDateOf } from '../../crew/knock-sale-rules.js';
import { validDate } from '../../crew/knock-time.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const refuse = (code, error) => ({ status: 'rejected', code, error });

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
export async function validateSaleEvent(store, rep, settings, event, { accepted = [], targets = new Map(), houses = new Map() } = {}) {
  if (!UUID.test(String(event.knockId || ''))) return refuse('knock_sale_invalid', 'The sale is missing its door.');
  const knock = accepted.find(a => a.id === event.knockId) || targets.get(event.knockId) || await store.get('knock_events', event.knockId);
  if (!knock || knock.type !== 'knock' || knock.outcome !== 'sold' || knock.repKey !== rep.repKey) return refuse('knock_sale_invalid', 'Log the door as Sold first.');
  if (event.houseId && event.houseId !== knock.houseId) return refuse('knock_sale_invalid', 'The sale and the door are different houses.');
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
  if (event.quotedAmount != null && !(Number(event.quotedAmount) >= 0)) return refuse('knock_sale_invalid', 'Quoted amount must be a number.');
  if (event.note != null && String(event.note).length > 500) return refuse('knock_sale_invalid', 'Note is too long.');
  const house = houses.get(knock.houseId) || await store.get('knock_houses', knock.houseId);
  if (!house) return refuse('knock_house_missing', 'That house is not in canvassing.');
  houses.set(knock.houseId, house);
  return null;
}

/* The sale record. Returns the writes for the sync commit (the caller has validated it). */
export async function applySaleEvent(store, rep, settings, event, nowIso, { houses = new Map() } = {}) {
  const knock = await store.get('knock_events', event.knockId).catch(() => null);
  const houseId = event.houseId || knock?.houseId;
  const house = houses.get(houseId) || await store.get('knock_houses', houseId);
  const saleDate = saleDateOf(event.at);
  const window = cancellationWindow(saleDate, { businessDays: settings.sale.cancelBusinessDays, extraHolidays: settings.sale.extraHolidays });
  const ticket = Math.round(Number(event.ticket) * 100) / 100;
  const sale = {
    repKey: rep.repKey, leadKey: rep.leadKey || '', knockId: event.knockId, houseId,
    neighborhoodId: house?.neighborhoodId || '', street: house?.street || '',
    address: { number: house?.number || '', street: house?.street || '', unit: house?.unit || '' },
    customer: { name: String(event.customer.name).trim(), phone: normalizePhone(event.customer.phone), email: String(event.customer.email).trim().toLowerCase() },
    textConsent: event.textConsent === true,
    ticket, package: event.package, quotedAmount: event.quotedAmount != null ? Number(event.quotedAmount) : null,
    depositRate: settings.sale.depositRate, depositAmount: depositAmount(ticket, settings.sale.depositRate),
    soldAt: event.at, saleDate, cancelDeadlineDate: window.deadlineDate, cancelEndsAt: new Date(window.cancelEndsAt).toISOString(),
    earliestJobDate: window.earliestJobDate, jobDate: event.jobDate, jobStartTime: event.jobStartTime || settings.sale.defaultJobStartTime,
    refundCutoffHours: settings.sale.refundCutoffHours,
    checklist: Object.fromEntries((settings.sale.checklist || []).map(item => [item.key, true])), checklistConfirmedAt: event.at,
    note: event.note ? String(event.note).slice(0, 500) : '',
    status: 'booked', statusHistory: [{ status: 'booked', at: event.at, by: rep.repKey }],
    completedAt: null, paidAt: null, cancelledAt: null, collectedAmount: null,
    handoff: {
      job: { mode: settings.integrations.job, status: 'pending', ref: '', at: null, by: '' },
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

/* Admin: move a sale to booked, cancelled, completed or paid. Paid records the collected amount
   (the ticket unless given) and completes the job if it was not marked complete. */
export async function setSaleStatus(store, admin, { saleId, status, collectedAmount, note }, nowIso) {
  if (!SALE_STATUSES.includes(status)) throw knockFailure('Unknown sale status.', 400, 'knock_invalid_status');
  const sale = await store.get('knock_sales', String(saleId || ''));
  if (!sale) throw knockFailure('That sale was not found.', 404, 'knock_sale_missing');
  if (sale.status === status) return { sale: repSaleView(sale) };
  if (!TRANSITIONS[sale.status]?.includes(status)) throw knockFailure(`A ${sale.status} sale cannot become ${status}.`, 409, 'knock_invalid_transition');
  const patch = { status, updatedAt: nowIso, statusHistory: [...(sale.statusHistory || []), { status, at: nowIso, by: admin.user, ...(note ? { note: String(note).slice(0, 200) } : {}) }] };
  if (status === 'cancelled') patch.cancelledAt = nowIso;
  if (status === 'booked') { patch.cancelledAt = null; patch.completedAt = null; patch.paidAt = null; patch.collectedAmount = null; }
  if (status === 'completed') { patch.completedAt = sale.completedAt || nowIso; patch.paidAt = null; patch.collectedAmount = null; }
  if (status === 'paid') {
    const amount = collectedAmount == null || collectedAmount === '' ? Number(sale.ticket) : Number(collectedAmount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) throw knockFailure('Enter the amount collected.', 400, 'knock_invalid_amount');
    patch.collectedAmount = Math.round(amount * 100) / 100;
    patch.paidAt = nowIso;
    patch.completedAt = sale.completedAt || nowIso;
  }
  await store.commit([write.patch('knock_sales', sale.id, patch, sale.__updateTime)]);
  return { sale: repSaleView({ ...sale, ...patch }) };
}

export async function setJobDate(store, admin, { saleId, jobDate, jobStartTime }, nowIso) {
  const sale = await store.get('knock_sales', String(saleId || ''));
  if (!sale) throw knockFailure('That sale was not found.', 404, 'knock_sale_missing');
  if (!validDate(jobDate) || jobDate < sale.earliestJobDate) throw knockFailure(`The job date must be ${sale.earliestJobDate} or later (after the cancellation deadline).`, 400, 'knock_sale_job_date');
  if (jobStartTime != null && !TIME.test(String(jobStartTime))) throw knockFailure('Job start time must be HH:MM.', 400, 'knock_invalid_time');
  const patch = { jobDate, ...(jobStartTime ? { jobStartTime } : {}), updatedAt: nowIso, statusHistory: [...(sale.statusHistory || []), { status: sale.status, at: nowIso, by: admin.user, note: `Job date ${jobDate}` }] };
  await store.commit([write.patch('knock_sales', sale.id, patch, sale.__updateTime)]);
  return { sale: repSaleView({ ...sale, ...patch }) };
}
