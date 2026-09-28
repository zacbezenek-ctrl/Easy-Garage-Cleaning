import { funnelDefinitions, funnelHubId, sha256Hex } from './funnel-definitions.js';
import { funnelEventWrite } from './funnel-events.js';
import { scheduleInterval } from './dispatch-time.js';

// FUN-02: the booking facts a visit records (channel, self-reported channel,
// booker, visit purpose, rework/membership link, CRM link reason) and the
// funnel events every schedule change writes in the SAME commit as the visit:
// walkthrough.booked / job.scheduled on first placement, *.rescheduled with
// from/to, reason, initiator and the occurrence counter on every later start
// change, *.cancelled with reasonCode and lateCancel, job.no_show, *.restored
// and job.assigned. Shared by dispatch (mutateDispatch), the operations bridge
// scheduler (mutateScheduledVisit) and GHL booking adoption.

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(secure_|_egc_)/.test(value);
const STRICT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, PROVIDER_ID = /^[A-Za-z0-9_-]{1,120}$/, STATUS = /^[a-z][a-z0-9_]{0,39}$/;
const ACTOR = /^[a-z0-9][a-z0-9_.@:+-]{0,119}$/, ROLE = /^[a-z][a-z_]{0,39}$/;
const OPERATIONAL = new Set(['job', 'cleanout', 'reorg']);
const BOOKING_KEYS = ['channel', 'channelSelfReported', 'visitPurpose', 'reworkOfJobId', 'membershipId', 'crmLinkReason'];
// Codes only history mappings may use (FUN-04), never a live choice.
const RESERVED_REASON = 'other_legacy', RESERVED_CHANNEL = 'jobber_legacy';
// Dispatch staff book by phone or in person; the other channels belong to their own writers.
const STAFF_CHANNELS = ['hub_phone', 'hub_in_person'];
const hubRef = value => funnelHubId(value) ? value : undefined;
const providerRef = value => typeof value === 'string' && PROVIDER_ID.test(value) ? value : undefined;
// A stored value the shared vocabulary does not know (a legacy or hand-edited field) is unknown, never fatal to the commit.
const known = (list, value) => funnelDefinitions().vocabularies[list].includes(value) ? value : undefined;
const statusOf = doc => { const value = String(doc?.pipelineStatus || doc?.status || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_'); return STATUS.test(value) ? value : undefined; };
export const visitKind = type => type === 'walkthrough' ? 'walkthrough' : OPERATIONAL.has(type) ? 'job' : null;
export const visitStart = doc => doc ? scheduleInterval(doc)?.startAt || null : null;
export const defaultVisitPurpose = type => visitKind(type) === 'walkthrough' ? 'walkthrough' : 'service';

/** The event actor for a Hub session or bridge actor. An id the ledger cannot
 * store verbatim is kept as a stable pseudonymous digest, never dropped. */
export function eventActor({ id, kind, role } = {}) {
  const value = String(id || '').trim().toLowerCase(), roleValue = String(role || '').toLowerCase();
  return { id: ACTOR.test(value) ? value : `sha256:${sha256Hex(`actor:${value}`).slice(0, 32)}`, kind: funnelDefinitions().vocabularies.actorKinds.includes(kind) ? kind : 'integration', role: ROLE.test(roleValue) ? roleValue : null };
}

/** The event `via` for a bridge write: the prepared bridge.via (the one its hub_audit entry records) when the ledger knows it, else 'bridge'. */
export const eventVia = via => funnelDefinitions().vocabularies.via.includes(via) ? via : 'bridge';

/** A provider booking time as the event clock, when it lies inside the ledger's accepted range; otherwise the server time is used. */
export function providerClock(occurredAt, now) {
  const integrity = funnelDefinitions().eventIntegrity, at = typeof occurredAt === 'string' ? Date.parse(occurredAt) : NaN;
  return Number.isFinite(at) && at >= Date.parse(integrity.earliestOccurredAt) && at <= Date.parse(now) + integrity.maxFutureMinutes * 60000 ? { clockSource: 'provider', occurredAt: new Date(at).toISOString() } : null;
}

/** The funnel idempotency key for a mutation requestId. Hub writers accept any
 * hex UUID; a non-RFC one maps to a stable RFC 9562 version-8 id. */
export function requestKey(requestId) {
  const value = String(requestId || '').toLowerCase();
  if (STRICT_UUID.test(value)) return { kind: 'requestId', value };
  const hex = sha256Hex(`request:${value}`);
  return { kind: 'requestId', value: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}` };
}

/**
 * Validates the optional `booking` of a schedule.create: {channel?,
 * channelSelfReported?, visitPurpose?, reworkOfJobId?, membershipId?,
 * crmLinkReason?}. A walkthrough is always visitPurpose 'walkthrough'; a job
 * defaults to 'service' (the legacy meaning of every job). A rework visit needs
 * reworkOfJobId and a member visit needs membershipId, and neither takes the
 * other. `fail(reason, message, status)` builds the caller's error.
 */
export function bookingInput(value, type, fail) {
  const definitions = funnelDefinitions(), vocab = definitions.vocabularies;
  const booking = value ?? {};
  if (!plain(booking) || Object.keys(booking).some(key => !BOOKING_KEYS.includes(key))) throw fail('booking_invalid', 'The booking details contain unsupported fields. Refresh the form and try again.');
  const pick = (name, list, label) => {
    const item = booking[name];
    if (item === undefined || item === null || item === '') return null;
    if (typeof item !== 'string' || !list.includes(item)) throw fail('booking_invalid', `Choose a valid ${label}.`);
    return item;
  };
  const kind = visitKind(type);
  const purposes = kind === 'walkthrough' ? ['walkthrough'] : vocab.visitPurposes.filter(purpose => purpose !== 'walkthrough');
  const visitPurpose = pick('visitPurpose', purposes, 'visit purpose') || defaultVisitPurpose(type);
  const reworkOfJobId = booking.reworkOfJobId ?? null, membershipId = booking.membershipId ?? null;
  if (visitPurpose === 'rework' ? !safeId(reworkOfJobId) : reworkOfJobId !== null) throw fail('booking_rework_invalid', 'A rework visit needs the original job it reworks, and only a rework visit takes one.');
  if (visitPurpose === 'member_visit' ? typeof membershipId !== 'string' || !PROVIDER_ID.test(membershipId) : membershipId !== null) throw fail('booking_membership_invalid', 'A member visit needs its membership ID, and only a member visit takes one.');
  return {
    bookingChannel: pick('channel', vocab.bookingChannels.filter(channel => channel !== RESERVED_CHANNEL), 'booking channel'),
    channelSelfReported: pick('channelSelfReported', vocab.selfReportedChannels, 'answer to how the customer heard about us'),
    visitPurpose, reworkOfJobId, membershipId,
    crmLinkReason: pick('crmLinkReason', vocab.crmLinkReasons, 'reason there is no CRM contact'),
  };
}

/** The job fields a booking writes. crmLinkReason is kept only when the visit has no CRM contact. */
export function bookingPatch(booking, { bookedBy, highlevelContactId }) {
  return { bookingChannel: booking.bookingChannel, channelSelfReported: booking.channelSelfReported, bookedBy, visitPurpose: booking.visitPurpose,
    ...(booking.reworkOfJobId ? { reworkOfJobId: booking.reworkOfJobId } : {}), ...(booking.membershipId ? { membershipId: booking.membershipId } : {}),
    crmLinkReason: highlevelContactId ? null : booking.crmLinkReason };
}

/** A reschedule, cancel or no-show reason: {reasonCode, initiatedBy}, each null when not given. `list` is 'reschedule', 'cancel' or 'noShow'. */
export function reasonInput(input, list, fail) {
  const definitions = funnelDefinitions(), codes = definitions.reasonCodes[list].filter(code => code !== RESERVED_REASON);
  const reasonCode = input?.reasonCode ?? null, initiatedBy = input?.initiatedBy ?? null;
  if (reasonCode !== null && (typeof reasonCode !== 'string' || !codes.includes(reasonCode))) throw fail('reason_code_invalid', 'Choose one of the listed reasons.');
  if (initiatedBy !== null && (typeof initiatedBy !== 'string' || !definitions.vocabularies.initiatedBy.includes(initiatedBy))) throw fail('reason_code_invalid', 'Choose who asked for this change.');
  return { reasonCode, initiatedBy };
}

/** The start a cancel is measured from: the visit's start instant; null when it was never
 * placed; undefined when it has a saved date or time that cannot be read (timeNeedsReview). */
export const cancelStart = visit => visitStart(visit) || (['date', 'time', 'endDate', 'endTime'].some(key => typeof visit?.[key] === 'string' && visit[key].trim()) ? undefined : null);

/** True when a customer cancels within metricWindows.lateCancelHours of the start (or after it); false for company or system cancels and for a visit that was never placed; null when nobody said who asked or the start cannot be read. */
export function lateCancel(startAt, now, initiatedBy) {
  if (initiatedBy !== 'customer') return initiatedBy ? false : null;
  if (startAt === null) return false;
  const start = typeof startAt === 'string' ? Date.parse(startAt) : NaN;
  return Number.isFinite(start) ? start - Date.parse(now) < funnelDefinitions().metricWindows.lateCancelHours * 3600000 : null;
}

/** The cancel fields saved next to the free-text cancellationReason. A cancel sent without a code (older clients) records other_legacy, exactly as FUN-04 maps legacy history. */
export function cancelPatch(reason, visit, now) {
  return { cancellationReasonCode: reason.reasonCode || RESERVED_REASON, cancellationInitiatedBy: reason.initiatedBy, lateCancel: lateCancel(cancelStart(visit), now, reason.initiatedBy) };
}

/** A no-show is recorded on a placed customer job from one hour before its start.
 * A walkthrough no-show is the walkthrough visit's own outcome (FUN-05). */
export function noShowProblem(current, now) {
  const interval = scheduleInterval(current);
  if (visitKind(current?.type) === 'walkthrough') return 'no_show_walkthrough';
  if (visitKind(current?.type) !== 'job' || !interval) return 'no_show_invalid';
  return interval.start - 3600000 > Date.parse(now) ? 'no_show_too_early' : null;
}

/** Lists the dispatch forms offer, from the shared definitions (null when they cannot be read). */
export function dispatchFunnelOptions() {
  try {
    const definitions = funnelDefinitions(), vocab = definitions.vocabularies, live = list => list.filter(code => code !== RESERVED_REASON);
    return { visitPurposes: vocab.visitPurposes.filter(purpose => purpose !== 'walkthrough'), bookingChannels: STAFF_CHANNELS.filter(channel => vocab.bookingChannels.includes(channel)),
      selfReportedChannels: [...vocab.selfReportedChannels], crmLinkReasons: [...vocab.crmLinkReasons], initiatedBy: vocab.initiatedBy.filter(value => value !== 'system'),
      reasonCodes: { cancel: live(definitions.reasonCodes.cancel), reschedule: live(definitions.reasonCodes.reschedule), noShow: live(definitions.reasonCodes.noShow) } };
  } catch { return null; }
}

/**
 * The funnel event writes for one visit change, for the caller's commit.
 *   action   'create' | 'update' | 'cancel' | 'restore' | 'no_show'
 *   before   the saved visit (null on create); after: the visit as committed, with its id
 *   actor    {id, kind, role}; via: 'hub' | 'bridge' | ...; key: {kind, value}; source: {collection, id}
 *   reason   {reasonCode, initiatedBy, lateCancel} for reschedule, cancel and no-show
 *   crewChanged  the assigned crew changed to a non-empty crew (jobs only)
 *   bookedClock  {clockSource, occurredAt} for a provider-timed booking (adoption)
 * The occurrence counter counts the start instants a visit has been placed at:
 * the first placement is the booking, every later start change a reschedule.
 * Taking a placed visit off the calendar is a reschedule without toStartAt.
 * A change of end time alone moves nothing. Returns {writes, patch} where patch
 * carries scheduleOccurrence for the visit.
 */
export async function visitFunnelWrites({ action, before = null, after, actor, via, key, source, reason = {}, crewChanged = false, bookedClock = null, now }) {
  const kind = visitKind(after?.type);
  if (!kind) return { writes: [], patch: {} };
  const family = kind === 'walkthrough' ? 'walkthrough' : 'job', visit = kind === 'walkthrough' ? { walkthroughId: after.id } : { jobId: after.id };
  const base = { idempotencyKey: key, projectId: hubRef(after.projectId), customerId: hubRef(after.customerId), highlevelContactId: providerRef(after.highlevelContactId), membershipId: providerRef(after.membershipId), actor, via, source, eligibility: { hub: after } };
  const events = [], patch = {};
  const add = (type, data, extra = {}) => events.push({ type, ...base, ...visit, ...extra, data: Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined && value !== null)) });
  const from = visitStart(before), to = visitStart(after);
  // A placed visit has been placed at least once, whatever its (legacy or hand-edited) counter says.
  const prior = Math.max(Number.isInteger(before?.scheduleOccurrence) && before.scheduleOccurrence >= 0 ? before.scheduleOccurrence : 0, from ? 1 : 0);
  const counted = value => value >= 1 && value <= 1000 ? value : undefined;
  // Cancelling a visit that is already cancelled (the bridge allows it) is not a second cancellation.
  if (action === 'cancel') { if (!['cancelled', 'canceled'].includes(statusOf(before))) add(`${family}.cancelled`, { reasonCode: reason.reasonCode || RESERVED_REASON, initiatedBy: reason.initiatedBy, lateCancel: reason.lateCancel, ...(kind === 'job' ? { fromStatus: statusOf(before) } : {}) }); }
  else if (action === 'no_show') add(`${family}.no_show`, { reasonCode: reason.reasonCode, occurrence: counted(prior) });
  else {
    if (action === 'restore') add(`${family}.restored`, { fromStatus: statusOf(before), toStatus: statusOf(after) });
    if (to && to !== from) {
      if (prior === 0) {
        add(kind === 'walkthrough' ? 'walkthrough.booked' : 'job.scheduled', { channel: known('bookingChannels', after.bookingChannel), channelSelfReported: known('selfReportedChannels', after.channelSelfReported), visitPurpose: known('visitPurposes', after.visitPurpose) || defaultVisitPurpose(after.type), occurrence: 1 }, bookedClock || {});
        patch.scheduleOccurrence = 1;
      } else {
        add(`${family}.rescheduled`, { reasonCode: reason.reasonCode, initiatedBy: reason.initiatedBy, occurrence: counted(prior + 1), fromStartAt: from, toStartAt: to });
        patch.scheduleOccurrence = prior + 1;
      }
    } else if (!to && from && action === 'update') {
      add(`${family}.rescheduled`, { reasonCode: reason.reasonCode, initiatedBy: reason.initiatedBy, fromStartAt: from });
      // Saves the placement a legacy visit (no counter yet) implies, so its next placement is a reschedule.
      patch.scheduleOccurrence = prior;
    } else if (action === 'create') patch.scheduleOccurrence = 0;
    if (crewChanged && kind === 'job') add('job.assigned', {});
  }
  const writes = [];
  for (const event of events) writes.push(await funnelEventWrite(null, now, event));
  return { writes, patch };
}
