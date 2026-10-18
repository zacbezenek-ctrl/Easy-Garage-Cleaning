// KNOCK-BRIDGE (EGC_KNOCK_JOB_BRIDGE): a walkthrough a rep sets at the door. The door is logged as
// "Walkthrough set" (a knock event); a 'walkthrough' event follows with the customer's name, phone and the
// estimator slot the rep picked (or, offline, a day and morning/afternoon). Like a sale, the customer's details
// live only on this record (knock_walkthroughs, keyed by the phone's event id), never on houses or events.
// The estimator booking itself runs after the event syncs (knock-bridge.js bookWalkthrough), idempotent on the id.
import { write } from './knock-store.js';
import { WALKTHROUGH_OUTCOME } from '../../crew/knock-settings.js';
import { validDate } from '../../crew/knock-time.js';
import { normalizePhone } from './knock-sales.js';
import { nativeClaimActive } from './knock-form-claims.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ZIP = /^\d{5}$/;
const REF = /^[a-f0-9]{16}$/;
const refuse = (code, error) => ({ status: 'rejected', code, error });

/* The walkthroughs set at a house that still stand (not replaced by a sale): one bounded equality query. */
export async function activeWalkthroughs(store, houseId) {
  if (!houseId) return [];
  const rows = await store.query('knock_walkthroughs', { where: [['houseId', '==', houseId]], limit: 10 });
  return rows.filter(row => !row.supersededBySaleId && row.status !== 'superseded');
}

/* A Sold or "Walkthrough set" door at a house where another rep's walkthrough stands is refused while the bridge is
   on: one house, one attribution, and no estimator sent to a customer who already bought. The rep who set it may still
   sell (the walkthrough is then superseded); the office settles any other case. */
export async function otherRepWalkthrough(store, houseId, repKey) {
  return (await activeWalkthroughs(store, houseId)).some(row => row.repKey !== repKey);
}

/* The customer at this house already bought at the door: a sale stands there (any rep's, not cancelled), or one is in
   this sync. No estimator walkthrough is set over it, whoever sets it; the office settles a change of plan. One bounded
   equality query (knock_sales.houseId, as native form requests read it). */
export const HOUSE_SOLD = 'This house already has a sale at the door. Ask the office before setting a walkthrough.';
export async function houseSold(store, houseId, accepted = []) {
  if (!houseId) return false;
  if (accepted.some(a => a.type === 'sale' && a.houseId === houseId)) return true;
  return (await store.query('knock_sales', { where: [['houseId', '==', houseId]], limit: 20 })).some(sale => sale.status !== 'cancelled');
}

/* A native form claim on the house (knock-form-handoff.js) that a walkthrough set here would stack on: any active
   claim except this rep's own native walkthrough request. */
export const walkthroughClaimConflict = (claim, rep) => nativeClaimActive(claim) && !(claim.channel === 'walkthrough_request' && claim.repKey === rep.repKey);

/* Validate a walkthrough event against the rep's "Walkthrough set" door. Returns a rejection or null. */
export async function validateWalkthroughEvent(store, rep, event, { accepted = [], targets = new Map(), houses = new Map() } = {}) {
  if (!UUID.test(String(event.knockId || ''))) return refuse('knock_walkthrough_invalid', 'The walkthrough is missing its door.');
  const knock = accepted.find(a => a.id === event.knockId) || targets.get(event.knockId) || await store.get('knock_events', event.knockId);
  if (!knock || knock.type !== 'knock' || knock.outcome !== WALKTHROUGH_OUTCOME || knock.repKey !== rep.repKey) return refuse('knock_walkthrough_invalid', 'Log the door as Walkthrough set first.');
  if (event.houseId && event.houseId !== knock.houseId) return refuse('knock_walkthrough_invalid', 'The walkthrough and the door are different houses.');
  const existing = await store.query('knock_walkthroughs', { where: [['knockId', '==', knock.id]], limit: 1 });
  if (existing.length || accepted.some(a => a.type === 'walkthrough' && a.knockId === knock.id)) return refuse('knock_walkthrough_exists', 'That door already has a walkthrough.');
  // One standing walkthrough per house: a second one would send a second estimator and split the setter credit.
  if ((await activeWalkthroughs(store, knock.houseId)).length || accepted.some(a => a.type === 'walkthrough' && a.houseId === knock.houseId))
    return refuse('knock_walkthrough_exists', 'This house already has a walkthrough set. Ask the office to change it in the Hub.');
  if (await houseSold(store, knock.houseId, accepted)) return refuse('knock_house_sold', HOUSE_SOLD);
  const name = String(event.customer?.name || '').trim();
  if (!name || name.length > 80) return refuse('knock_walkthrough_customer', 'Enter the customer\'s name.');
  if (!normalizePhone(event.customer?.phone)) return refuse('knock_walkthrough_customer', 'Enter a 10-digit US phone number.');
  const email = String(event.customer?.email || '').trim();
  if (email && !EMAIL.test(email)) return refuse('knock_walkthrough_customer', 'Check the email address, or leave it blank.');
  if (!validDate(event.date)) return refuse('knock_walkthrough_date', 'Pick the walkthrough day.');
  if (event.time != null && !TIME.test(String(event.time))) return refuse('knock_walkthrough_invalid', 'The walkthrough time must be HH:MM.');
  if (event.dayPart != null && !['am', 'pm'].includes(event.dayPart)) return refuse('knock_walkthrough_invalid', 'Choose morning or afternoon.');
  if (event.time == null && event.dayPart == null) return refuse('knock_walkthrough_invalid', 'Pick a time, or morning or afternoon.');
  if (event.estimatorRef != null && !REF.test(String(event.estimatorRef))) return refuse('knock_walkthrough_invalid', 'Pick the walkthrough slot again.');
  if (event.zip != null && event.zip !== '' && !ZIP.test(String(event.zip))) return refuse('knock_walkthrough_zip', 'Enter the 5-digit ZIP code.');
  if (event.city != null && (typeof event.city !== 'string' || event.city.length > 60)) return refuse('knock_walkthrough_invalid', 'Town must be at most 60 characters.');
  if (event.note != null && String(event.note).length > 500) return refuse('knock_walkthrough_invalid', 'Note is too long.');
  if (typeof event.textConsent !== 'boolean') return refuse('knock_walkthrough_invalid', 'Say whether the customer agreed to a text.');
  const house = houses.get(knock.houseId) || await store.get('knock_houses', knock.houseId);
  if (!house) return refuse('knock_house_missing', 'That house is not in canvassing.');
  houses.set(knock.houseId, house);
  return null;
}

/* The walkthrough record. Returns the writes for the sync commit (the caller has validated it). */
export function applyWalkthroughEvent(rep, event, nowIso, { house = null, cityName = '' } = {}) {
  const record = {
    repKey: rep.repKey, leadKey: rep.leadKey || '', knockId: event.knockId, houseId: event.houseId || house?.id || '',
    neighborhoodId: house?.neighborhoodId || '', street: house?.street || '',
    address: { number: house?.number || '', street: house?.street || '', unit: house?.unit || '',
      city: String(event.city || cityName || '').trim().slice(0, 60), state: 'CO', zip: ZIP.test(String(event.zip || '')) ? String(event.zip) : '' },
    customer: { name: String(event.customer.name).trim(), phone: normalizePhone(event.customer.phone), email: String(event.customer.email || '').trim().toLowerCase() },
    textConsent: event.textConsent === true,
    // What the rep asked for. A picked slot names its estimator only by an opaque reference (knock-bridge.js).
    requested: { date: event.date, time: event.time || null, part: event.dayPart || null, estimatorRef: event.estimatorRef || null, source: event.time && event.estimatorRef ? 'slot' : 'preference' },
    note: event.note ? String(event.note).slice(0, 500) : '',
    setAt: event.at, status: 'set',
    booking: { status: 'pending', jobId: '', date: '', time: '', endTime: '', estimator: '', at: null, by: '' },
    createdAt: nowIso, updatedAt: nowIso,
  };
  return [write.create('knock_walkthroughs', event.id, record)];
}

/* What a rep sees of a walkthrough they set: the booking's day, time and the estimator's first name only. The
   estimator's staff key, the customer's other bookings and any roster detail never leave the server. */
export function repWalkthroughView(row) {
  const booking = row.booking || {};
  return {
    id: row.id, houseId: row.houseId, address: { number: row.address?.number || '', street: row.address?.street || '', unit: row.address?.unit || '' },
    customer: { name: row.customer?.name || '' }, setAt: row.setAt, requested: { date: row.requested?.date || '', time: row.requested?.time || null, part: row.requested?.part || null },
    status: row.status || 'set', booking: { status: booking.status || 'pending', date: booking.date || '', time: booking.time || '', endTime: booking.endTime || '', estimator: booking.estimator || '', message: booking.message || '' },
  };
}

export async function repWalkthroughs(store, repKey) {
  const rows = await store.query('knock_walkthroughs', { where: [['repKey', '==', repKey]] });
  return rows.map(repWalkthroughView).sort((a, b) => String(b.setAt).localeCompare(String(a.setAt)));
}

export const OFFICE_WALKTHROUGH_LIMIT = 100;
/* Admin > Sales (KNOCK-BRIDGE): the walkthroughs set at the door that are not in the Hub yet: still booking, waiting to
   retry, or refused for the office to look at (a customer the Hub cannot match safely, a refused booking). Booked and
   requested ones are in Dispatch and superseded ones replaced by a sale, so this is one bounded equality query on
   status 'set', oldest first, with the reason the office needs (code and error) and the customer's contact details. */
export async function officeWalkthroughs(store, limit = OFFICE_WALKTHROUGH_LIMIT) {
  const rows = await store.query('knock_walkthroughs', { where: [['status', '==', 'set']], limit });
  return rows.map(({ __updateTime, ...row }) => ({
    id: row.id, repKey: row.repKey, houseId: row.houseId, address: row.address, customer: row.customer, textConsent: row.textConsent === true,
    requested: row.requested, note: row.note || '', setAt: row.setAt,
    booking: { status: row.booking?.status || 'pending', code: row.booking?.code || '', error: row.booking?.error || '', message: row.booking?.message || '',
      attempts: Number(row.booking?.attempts || 0), retryAfter: row.booking?.retryAfter || null, at: row.booking?.at || null },
  })).sort((a, b) => String(a.setAt).localeCompare(String(b.setAt)));
}
