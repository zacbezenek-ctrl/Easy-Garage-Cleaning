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
 * nearby job's id); the id stays in the audit and the Hub record, never in customer text. A confirmed waiver is for its
 * day: the owner's override carries to the send and the signature only on that day (savedOwnerWaiver), and a job moved
 * to another day is checked again at portal approval, Hub Record approval and a reschedule (pickupWaiverProblem); a
 * reschedule to a day with another job in the ZIP code moves the waiver with it (pickupWaiverMove). A job the customer
 * approved or signed keeps the terms it was signed on (AGENTS.md section 4), its waiver included: it moves freely, with
 * an audited note (waiverNoteAudit).
 *
 * The winter sale (winter-sale.js) runs on the minimum's total and never takes a pickup below it (pickupFloorCents), so
 * a pickup at the minimum gets no sale credit and the two lines never show together. */
import { HAULING_GROUPS } from './quote-model.js';
import { AUTO_CREW_TYPES } from './dispatch-crew-assign.js';
import { jobClosed } from './change-orders.js';

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

/** The total a sale may never take a pickup below: the minimum, unless the quote is not a pickup or its minimum is waived.
 * A builder breakdown saved before the minimum (no pickup facts) that is all hauling is a pickup: no waiver predates it. */
export function pickupFloorCents(breakdown) {
  if (!plain(breakdown)) return 0;
  if (!plain(breakdown.pickup)) return haulingOnly(breakdown.lines) ? PICKUP_MINIMUM_CENTS : 0;
  return breakdown.pickup.haulingOnly === true && breakdown.pickup.waived !== true ? PICKUP_MINIMUM_CENTS : 0;
}

/** The 5-digit ZIP code ending a service address ("…, CO 80521", "80521-1234", optionally then the country), or ''.
 * A 5-digit house number is never read as one: only the address's end is. */
export function serviceZip(address) {
  const found = String(address || '').trim().match(/(?:^|[\s,])(\d{5})(?:-\d{4})?\s*(?:,?\s*(?:USA|US|United States))?\.?$/i);
  return found ? found[1] : '';
}
/** The first operational job (dispatch's job, cleanout or reorg: AUTO_CREW_TYPES; never this one, never a closed one:
 * change-orders.js jobClosed) on date whose address has zip, or null. */
export function nearbyJob(jobs, { jobId = '', date, zip }) {
  if (!zip) return null;
  return (Array.isArray(jobs) ? jobs : []).filter(plain).find(job => job.id !== jobId && AUTO_CREW_TYPES.includes(job.type || 'job') && job.date === date
    && !jobClosed(job) && serviceZip(job.address) === zip) || null;
}
/** The waiver a job's record holds (the signed job's, else its quote draft's), or null. */
export const jobWaiver = job => plain(job?.minimumWaiver) ? job.minimumWaiver : plain(job?.quoteDraft?.minimumWaiver) ? job.quoteDraft.minimumWaiver : null;
// The job's current builder pricing: the signed quote's, else its draft's.
const currentBreakdown = job => plain(job?.compositeQuote?.breakdown) ? job.compositeQuote.breakdown : plain(job?.quoteDraft?.breakdown) ? job.quoteDraft.breakdown : null;
/** The waiver that prices the job now: its record, while its current pricing is waived (breakdown.pickup.waived) and
 * carries no Minimum pickup line; a record left from an earlier, waived revision is not live. */
export function liveWaiver(job) {
  const waiver = jobWaiver(job), lines = Array.isArray(job?.estimate?.lineItems) ? job.estimate.lineItems : [];
  return waiver && currentBreakdown(job)?.pickup?.waived === true && !lines.some(line => line?.id === PICKUP_MINIMUM_LINE_ID) ? waiver : null;
}
const acceptedStatus = value => ['accepted', 'approved'].includes(String(value || '').toLowerCase());
/** A job the customer approved (portal or Hub Record approval) or signed in person: it keeps the terms it was signed on. */
export const approvedJob = job => acceptedStatus(job?.estimate?.status) || acceptedStatus(job?.customerApproval?.status) || job?.estimate?.acceptanceMethod === 'in_person_signature';
/** The owner's saved override, carried to a send or signature only for its own day, its own reason and its own service ZIP
 * code (a record from before the ZIP code was kept matches any). */
export const savedOwnerWaiver = (saved, { date, reason, address = '' }) => plain(saved) && saved.ownerOverride === true && saved.pending !== true && Boolean(date) && saved.date === date && saved.reason === reason
  && (!saved.zip || saved.zip === serviceZip(address)) ? saved : null;
/**
 * Why a job's truck-nearby price no longer holds, or null: the job moved to another day than the one its waiver was
 * confirmed for and no other job is booked on the new day in its ZIP code (sameDayJobs: the jobs dated the new day;
 * null when they cannot be read, which refuses). An owner override is for its own day only. approving: an unconfirmed
 * (pending) waiver is refused too. The reason is the staff's; a customer gets a plain request to ask the team.
 */
export function pickupWaiverProblem(job, sameDayJobs = null, { approving = false } = {}) {
  const waiver = liveWaiver(job);
  if (!waiver) return null;
  if (waiver.pending) return approving ? 'The truck-nearby waiver on this quote has not been confirmed for a booked day yet. Send the quote again, which checks it.' : null;
  const date = String(job?.date || ''), zip = serviceZip(job?.address), zipMoved = waiverZipMoved(waiver, job);
  // Unscheduled since it was confirmed: an approval waits for the day to be booked again (a reschedule checks that day).
  if (!date) return approving && waiver.date ? `Book the job's day again before approving: the truck-nearby price was confirmed for ${waiver.date}.` : null;
  if (date === waiver.date && !zipMoved) return null;
  const confirmed = date === waiver.date ? `The truck-nearby price on this quote was confirmed for another ZIP code (${waiver.zip}).` : `The truck-nearby price on this quote was confirmed for ${waiver.date || 'another day'}.`;
  if (waiver.ownerOverride || !Array.isArray(sameDayJobs)) return `${confirmed} Save the quote again for ${date}: the $250 minimum pickup applies unless another job is booked that day in the same ZIP code, or the owner waives it.`;
  return nearbyJob(sameDayJobs, { jobId: job.id, date, zip }) ? null : `${confirmed} No other job is booked on ${date} in this job's ZIP code. Save the quote again (the $250 minimum pickup applies) or ask the owner.`;
}
/** Whether the job's service ZIP code is no longer the one its waiver was confirmed for (a record without one: never). */
export const waiverZipMoved = (waiver, job) => Boolean(waiver?.zip) && serviceZip(job?.address) !== waiver.zip;
/** The waiver confirmed again for a job moved to a day with another job in its ZIP code (sameDayJobs: that day's jobs):
 * the record with its new day and nearby job, or null when nothing moves with it. */
export function pickupWaiverMove(job, sameDayJobs) {
  const waiver = liveWaiver(job), date = String(job?.date || ''), zip = serviceZip(job?.address);
  if (!waiver || waiver.pending || waiver.ownerOverride || !date || date === waiver.date && !waiverZipMoved(waiver, job)) return null;
  const found = nearbyJob(sameDayJobs, { jobId: job.id, date, zip });
  return found ? { ...waiver, date, zip, nearbyJobId: found.id } : null;
}
/** The audit of a waiver that moved with its job: kept (an approved or signed job) or confirmed again for the new day. */
export const waiverNoteAudit = (auditWrite, waiver, { actor, via = 'hub', jobId, requestId, now, note, fromDate, toDate, fromZip, toZip, previous = waiver }) => auditWrite({ actor, via, action: 'quote.minimum_pickup.waiver_moved',
  entity: { collection: 'jobs', id: jobId }, before: { date: fromDate, nearbyJobId: previous?.nearbyJobId ?? null, zip: fromZip ?? previous?.zip ?? null },
  after: { date: toDate, nearbyJobId: waiver.nearbyJobId ?? null, zip: toZip ?? waiver.zip ?? null, ownerOverride: waiver.ownerOverride === true }, requestId, reason: note, now });

/**
 * Confirms a quote's waiver. priced: the builder pricing (breakdown.pickup); date/address: the job's booked day and
 * service address ('' when not booked yet); nearbyJobs(date): the jobs dated that day. Returns null when nothing is
 * waived (no waiver, or the quote is no pickup below the minimum), {pending:true} when no date is booked yet (allowed only
 * where pending is), else {nearbyJobId, ownerOverride, date}. An unconfirmable waiver throws 409
 * `${prefix}pickup_waiver_unconfirmed` (quote_draft_ or handoff_).
 */
// What the waiver's check reads: the jobs dated one day (dispatch storage), only for a quote that asks for the waiver.
export const pickupReaders = {
  nearby: async (env, date) => (await import('./dispatch-storage.js')).dispatchStorage(env).datedJobs(date, date, ['id', 'date', 'address', 'type', 'status', 'pipelineStatus']),
};
/** The Hub record of a confirmed waiver (quoteDraft.minimumWaiver): {by, at, reason, nearbyJobId, ownerOverride, date,
 * pending}. The nearby job's id stays here and in the audit, never in customer text. */
export const waiverRecord = (confirmed, { reason, by, at }) => ({ by, at, reason, nearbyJobId: confirmed.nearbyJobId ?? null, ownerOverride: confirmed.ownerOverride === true, date: confirmed.date ?? null, zip: confirmed.zip || null, pending: confirmed.pending === true });
/** The audit of a waiver (hub_audit, in the same commit): who, when, the reason and the nearby job. */
export const waiverAudit = (auditWrite, record, { actor, jobId, requestId, now, via = 'hub' }) => auditWrite({ actor: { id: actor.user, kind: 'human', role: actor.role }, via, action: 'quote.minimum_pickup.waive',
  entity: { collection: 'jobs', id: jobId }, before: null, after: { nearbyJobId: record.nearbyJobId, ownerOverride: record.ownerOverride, date: record.date, pending: record.pending }, requestId, reason: record.reason, now });

export async function confirmNearbyTruck({ priced, owner = false, jobId = '', date = '', address = '', nearbyJobs, pending = false, prefix = '' }) {
  const pickup = priced?.breakdown?.pickup;
  if (!plain(pickup) || pickup.waived !== true || !(pickup.waivedCents > 0)) return null;
  if (!date) {
    if (pending) return { pending: true };
    throw fail(prefix, 'Book the job date first: the truck-nearby waiver needs another job booked the same day in the same ZIP code.');
  }
  const zip = serviceZip(address), found = zip ? nearbyJob(await nearbyJobs(date), { jobId, date, zip }) : null;
  if (found) return { nearbyJobId: found.id, ownerOverride: false, date, zip };
  if (owner) return { nearbyJobId: null, ownerOverride: true, date, zip };
  throw fail(prefix, zip ? `No other job is booked on ${date} in this job's ZIP code, so the truck-nearby waiver can't apply. Remove the waiver (the $250 minimum pickup applies) or ask the owner.`
    : 'This job\'s address has no 5-digit ZIP code to find a nearby truck. Add it, remove the waiver (the $250 minimum pickup applies), or ask the owner.');
}
