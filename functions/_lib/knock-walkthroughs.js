// KNOCK-BRIDGE (EGC_KNOCK_JOB_BRIDGE): a walkthrough a rep sets at the door. The door is logged as
// "Walkthrough set" (a knock event); a 'walkthrough' event follows with the customer's name, phone and the
// estimator slot the rep picked (or, offline, a day and morning/afternoon). Like a sale, the customer's details
// live only on this record (knock_walkthroughs, keyed by the phone's event id), never on houses or events.
// The estimator booking itself runs after the event syncs (knock-bridge.js bookWalkthrough), idempotent on the id.
import { write } from './knock-store.js';
import { WALKTHROUGH_OUTCOME } from '../../crew/knock-settings.js';
import { validDate } from '../../crew/knock-time.js';
import { normalizePhone } from './knock-sales.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ZIP = /^\d{5}$/;
const REF = /^[a-f0-9]{16}$/;
const refuse = (code, error) => ({ status: 'rejected', code, error });

/* Validate a walkthrough event against the rep's "Walkthrough set" door. Returns a rejection or null. */
export async function validateWalkthroughEvent(store, rep, event, { accepted = [], targets = new Map(), houses = new Map() } = {}) {
  if (!UUID.test(String(event.knockId || ''))) return refuse('knock_walkthrough_invalid', 'The walkthrough is missing its door.');
  const knock = accepted.find(a => a.id === event.knockId) || targets.get(event.knockId) || await store.get('knock_events', event.knockId);
  if (!knock || knock.type !== 'knock' || knock.outcome !== WALKTHROUGH_OUTCOME || knock.repKey !== rep.repKey) return refuse('knock_walkthrough_invalid', 'Log the door as Walkthrough set first.');
  if (event.houseId && event.houseId !== knock.houseId) return refuse('knock_walkthrough_invalid', 'The walkthrough and the door are different houses.');
  const existing = await store.query('knock_walkthroughs', { where: [['knockId', '==', knock.id]], limit: 1 });
  if (existing.length || accepted.some(a => a.type === 'walkthrough' && a.knockId === knock.id)) return refuse('knock_walkthrough_exists', 'That door already has a walkthrough.');
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
