/** Minimum pickup (owner decision 2026-10-21: "minimum pickup should be 250, unless they are booking when a truck is
 * nearby"). A builder quote whose menu lines are all hauling (truck loads, special-handling items, access charges:
 * HAULING_GROUPS), with or without a truck load, is a pickup. Below $250 in all (its Labor line, if any, included) it
 * gets a visible customer line, "Minimum pickup", that raises it to exactly $250 (composite-quote.js priceCompositeQuote,
 * server-only: the browser never adds, removes or prices it, and a save whose lines differ is refused). It never
 * changes junkOnly (the minimum line is not a menu line) or the Labor line. Any quote with garage work is untouched.
 *
 * The waiver, "Truck already nearby": the selection carries nearbyTruck:{reason} (3 to 300 characters, never customer
 * data), and the quote is then priced without the minimum. The server confirms it (confirmNearbyTruck) once the job's
 * date is known (a save of a booked job, the send, the in-person signature): another scheduled job, not cancelled, on
 * the same day whose service address has the same 5-digit ZIP code. The owner may waive it without one (an override).
 * Unconfirmed, the save, send or signature is refused with a plain reason. Each confirmation is audited (who, when, the
 * nearby job's id); the id stays in the audit and the Hub record, never in customer text.
 *
 * The winter sale (winter-sale.js) runs on the minimum's total and never takes a pickup below it (pickupFloorCents), so
 * a pickup at the minimum gets no sale credit and the two lines never show together. */
import { HAULING_GROUPS } from './quote-model.js';

export const PICKUP_MINIMUM_CENTS = 25000;
export const PICKUP_MINIMUM_LINE_ID = 'minimum-pickup';
export const PICKUP_MINIMUM_LINE_NAME = 'Minimum pickup';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (prefix, message) => Object.assign(new Error(message), { code: `${prefix}pickup_waiver_unconfirmed`, status: 409 });

/** Whether a builder breakdown's lines (the menu lines, not Labor) are all hauling: a pickup. */
export const haulingOnly = lines => Array.isArray(lines) && lines.length > 0 && lines.every(line => plain(line) && line.section === 'removal' && HAULING_GROUPS.includes(line.group));

/** The customer's line that raises a pickup to the minimum (a fee of cents). */
export const pickupMinimumLine = cents => ({ id: PICKUP_MINIMUM_LINE_ID, kind: 'fee', name: PICKUP_MINIMUM_LINE_NAME, description: 'Raises this pickup to the $250 minimum.', quantity: 1, unitCents: cents, totalCents: cents, optional: false, selected: true, taxable: false });

/** The waiver a selection may carry: {reason}; anything else is refused. */
export function normalizeNearbyTruck(value, refuse) {
  if (!plain(value) || Object.keys(value).some(key => key !== 'reason') || typeof value.reason !== 'string' || value.reason.trim().length < 3 || value.reason.length > 300) throw refuse('Give the reason the truck is already nearby (3 to 300 characters, like a nearby job number or area).');
  return { reason: value.reason.trim() };
}

/** The total a sale may never take a pickup below: the minimum, unless the quote is not a pickup or its minimum is waived. */
export const pickupFloorCents = breakdown => plain(breakdown?.pickup) && breakdown.pickup.haulingOnly === true && breakdown.pickup.waived !== true ? PICKUP_MINIMUM_CENTS : 0;

/** The 5-digit ZIP code of a service address (its last one), or ''. */
export function serviceZip(address) {
  const found = String(address || '').match(/\b\d{5}(?:-\d{4})?\b/g);
  return found ? found.at(-1).slice(0, 5) : '';
}
const CLOSED = new Set(['cancelled', 'canceled', 'no_show', 'noshow', 'no-show']);
/** The first scheduled job (not this one, not cancelled) on date whose address has zip, or null. */
export function nearbyJob(jobs, { jobId = '', date, zip }) {
  if (!zip) return null;
  return (Array.isArray(jobs) ? jobs : []).filter(plain).find(job => job.id !== jobId && (job.type || 'job') === 'job' && job.date === date
    && !CLOSED.has(String(job.pipelineStatus || job.status || '').toLowerCase()) && serviceZip(job.address) === zip) || null;
}

/**
 * Confirms a quote's waiver. priced: the builder pricing (breakdown.pickup); date/address: the job's booked day and
 * service address ('' when not booked yet); nearbyJobs(date): the jobs dated that day. Returns null when nothing is
 * waived (no waiver, or the quote is no pickup below the minimum), {pending:true} when no date is booked yet (allowed only
 * where pending is), else {nearbyJobId, ownerOverride, date}. An unconfirmable waiver throws 409
 * `${prefix}pickup_waiver_unconfirmed` (quote_draft_ or handoff_).
 */
export async function confirmNearbyTruck({ priced, owner = false, jobId = '', date = '', address = '', nearbyJobs, pending = false, prefix = '' }) {
  const pickup = priced?.breakdown?.pickup;
  if (!plain(pickup) || pickup.waived !== true || !(pickup.waivedCents > 0)) return null;
  if (!date) {
    if (pending) return { pending: true };
    throw fail(prefix, 'Book the job date first: the truck-nearby waiver needs another job booked the same day in the same ZIP code.');
  }
  const zip = serviceZip(address), found = zip ? nearbyJob(await nearbyJobs(date), { jobId, date, zip }) : null;
  if (found) return { nearbyJobId: found.id, ownerOverride: false, date };
  if (owner) return { nearbyJobId: null, ownerOverride: true, date };
  throw fail(prefix, zip ? `No other job is booked on ${date} in this job's ZIP code, so the truck-nearby waiver can't apply. Remove the waiver (the $250 minimum pickup applies) or ask the owner.`
    : 'This job\'s address has no 5-digit ZIP code to find a nearby truck. Add it, remove the waiver (the $250 minimum pickup applies), or ask the owner.');
}
