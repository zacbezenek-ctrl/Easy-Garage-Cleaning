/* D9/D9b: the HighLevel schedule mirror (EGC_GHL_SCHEDULE_MIRROR). The Hub keeps the schedule; HighLevel is a
   second record and must not depend on a calendar. With the flag exactly "true", a Hub schedule change that matters
   (a walkthrough booked, a job scheduled, moved, cancelled or marked a no-show, a crew or estimator assigned) writes
   ONE ghlScheduleMirror entry in the SAME Firestore commit as the change (scheduleMirrorWrites: the id is derived from
   the visit and its change key, created once). The API that saved it may make the first attempt after its response
   (firstScheduleMirrorAttempt, ctx.waitUntil); the signed /api/ghl-tag-drain tick (egc-worker, every 2 minutes)
   retries it. An attempt claims the entry first (compare-and-set) and re-reads the visit. A change the visit has since
   moved past is still told (every change gets its note, marked as replaced), but its stage step follows the visit as it
   is now, so a writer that queues nothing (or a later change) never leaves HighLevel behind. Delivery, each step
   recorded so a retry never repeats it:
     1. the customer's HighLevel contact: the visit's or its customer's linked contact (or the one this customer job
        already used); a new one is upserted only outside a messaging dry run, as the GHL-TRACK-1 tag outbox does;
     2. ONE opportunity per customer job (the Hub project) in the EGC Pipeline, moved forward to Walkthrough
        Appointment or Job Scheduled (highlevel-pipeline.js): never backwards past a later stage (a Paid in Full deal
        stays where it is), never a closed one, never a guess between several open ones (that parks for a person).
        A new one is created only when a search of EVERY status finds none for the contact in the pipeline, and only
        through the create-only POST /opportunities/ (web-lead-intake.js, docs/WEB-LEAD-SAFETY.md): HighLevel's upsert
        matches the contact's existing deal and would reopen a won or lost one. A contact with only closed deals (a
        repeat customer) waits for a person, like several open ones;
     3. one internal contact note for the change: date, Denver time window, crew or estimator, address and the job
        breakdown the visit carries (no prices).
   A walkthrough's opportunity is assigned to its estimator's HighLevel user when the staff profile maps one
   (highlevel-users.js), else HIGHLEVEL_USER_ID. Nothing here writes an appointment or sends a message: booked-status
   tags stay with the tag outbox and the calendar stays an optional mirror (highlevel-calendars.js).
   Door to door (the Knock bridge, knock-bridge.js): a job it made carries source 'door_to_door', d2d {kind, repKey}
   and ghlTags. The bridge adds them in the same commit as the job but after this entry was built, so delivery reads
   them from the visit: the note gets a "Door to door: sale|walkthrough set by <rep first name>" line, a contact the
   mirror creates and an opportunity it creates get the source "Door to door" (an existing opportunity's source is
   never changed), and, only with EGC_GHL_D2D_TAGS, the job's own D2D tag goes on the contact once, with its booking.
   Tags start HighLevel workflows (a customer text), so they have their own switch; off, no tag is ever added here.
   Failures back off 1, 5, 15, 60 minutes and park after 8 attempts for a manager's Retry. */
import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields } from './firestore-job.js';
import { dispatchStorage } from './dispatch-storage.js';
import { aggregateCount } from './dispatch-window-reads.js';
import { canDispatch } from './dispatch-permissions.js';
import { scheduleInterval } from './dispatch-time.js';
import { addContactNote, addTags, ensureContact, ghl, ghlScheduleMirrorEnabled, highLevelConfig } from './highlevel-tags.js';
import { schedulePipeline } from './highlevel-pipeline.js';
import { estimatorHighLevelUserId, walkthroughEstimator } from './highlevel-users.js';
import { GHL_TAG_DRAIN_STATE, GHL_TAG_DRAIN_STATE_ID, ghlTagDrainView } from './ghl-tag-outbox.js';

/** EGC_GHL_SCHEDULE_MIRROR: exactly "true" queues and delivers the schedule mirror. Anything else: nothing is written. */
export { ghlScheduleMirrorEnabled };
// Server-only collections; firestore.rules' catch-all denies every browser read and write.
export const GHL_SCHEDULE_MIRROR = 'ghlScheduleMirror';
export const GHL_SCHEDULE_MIRROR_LINKS = 'ghlScheduleMirrorLinks';
export const GHL_MIRROR_BACKOFF_MINUTES = Object.freeze([1, 5, 15, 60]);
export const GHL_MIRROR_PARK_ATTEMPTS = 8;
export const GHL_MIRROR_CLAIM_MINUTES = 5;
// Entries one drain call attempts: each costs about 8-12 subrequests (Firestore and HighLevel), on top of the tag outbox's pass.
export const GHL_MIRROR_DRAIN_LIMIT = 2;
export const GHL_MIRROR_SCAN_LIMIT = 500;
export const GHL_MIRROR_OVERDUE_MINUTES = 15;
export const GHL_MIRROR_KINDS = Object.freeze(['scheduled', 'rescheduled', 'crew_assigned', 'cancelled', 'no_show']);
export const GHL_MIRROR_STAGES = Object.freeze({ walkthrough: 'walkthrough_appointment', job: 'job_scheduled' });
/** The park code of an entry whose opportunity needs a person in HighLevel (several open deals, only closed ones, or a
 * link to someone else's); steps.opportunityReview says which. */
export const GHL_MIRROR_NEEDS_LINK = 'ghl_mirror_opportunity_needs_link';
// The Integrations status reads at most this many pending entries (they drain within minutes; parked ones are counted).
export const GHL_MIRROR_STATUS_SCAN_LIMIT = 100;
/** EGC_GHL_D2D_TAGS: exactly "true" lets the mirror add a door-to-door job's own tag to its contact. Anything else: the
 * mirror adds no tag and its requests are exactly what they are without this switch. */
export const ghlD2dTagsEnabled = env => env?.EGC_GHL_D2D_TAGS === 'true';
// The HighLevel source of a door-to-door contact or opportunity, and the only tags the mirror ever adds (the same
// values as knock-bridge.js D2D_CONTACT_SOURCE and D2D_GHL_TAGS, which this module cannot import: dispatch imports it).
export const GHL_D2D_SOURCE = 'Door to door';
export const GHL_D2D_TAGS = Object.freeze({ sale: 'egc-d2d-sale', walkthrough: 'egc-d2d-walkthrough' });
const D2D_TAG_LIST = Object.freeze(Object.values(GHL_D2D_TAGS)), REP_KEY = /^(?!\.{1,2}$)[a-z0-9_.-]{1,150}$/;
const ENTRY_ID = /^gsm_[0-9a-f]{40}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CANCELLED = new Set(['cancelled', 'canceled']), NO_SHOW = new Set(['noshow', 'no_show', 'no-show']);
const FINISHED = new Set(['completed', 'invoiced', 'paid', 'review_requested', 'closed']);
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const state = job => String(job?.pipelineStatus || job?.status || '').toLowerCase();
const visitKind = type => type === 'walkthrough' ? 'walkthrough' : ['job', 'cleanout', 'reorg'].includes(type) ? 'job' : null;
const startOf = job => job ? scheduleInterval(job)?.startAt || null : null;
const ms = value => { const at = Date.parse(typeof value === 'string' ? value : ''); return Number.isFinite(at) ? at : NaN; };
const iso = at => new Date(at).toISOString();
const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
const safeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(id) && !/^(_egc_|secure_)/.test(id);
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const hex = buffer => [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const sha = async text => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const clip = (value, size) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, size);
const opportunityPath = id => `/opportunities/${encodeURIComponent(id)}`;
const equals = (field, value) => ({ field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: value } });

export const scheduleMirrorChangeKey = (source, requestId) => `${source}:${String(requestId || '').toLowerCase()}`;
/** The entry id for one change: the same visit and change key always name the same entry. */
export const scheduleMirrorEntryId = async (jobId, changeKey) => `gsm_${(await sha(`${jobId}|${changeKey}`)).slice(0, 40)}`;
/** The link record of one customer job (the Hub project): its contact and its one opportunity. */
export const scheduleMirrorLinkId = async projectKey => `gml_${(await sha(projectKey)).slice(0, 40)}`;
export const ghlMirrorBackoffMinutes = attempts => GHL_MIRROR_BACKOFF_MINUTES[Math.min(Math.max(attempts, 1), GHL_MIRROR_BACKOFF_MINUTES.length) - 1];
const projectKeyOf = job => safeId(job?.projectId) ? job.projectId : `visit_${job?.id}`;

// The people on the visit (roster ids; a legacy name stays as written) and the crew record, as one comparable key.
function crewPeople(job) {
  const seen = new Map();
  for (const value of Array.isArray(job?.assignedCrew) ? job.assignedCrew : []) {
    const raw = typeof value === 'string' ? value : object(value) ? value.username || value.user || value.id || value.name || '' : '';
    const key = String(raw).trim().toLowerCase();
    if (key && !seen.has(key)) seen.set(key, String(raw).trim());
  }
  return [...seen].sort(([a], [b]) => a.localeCompare(b));
}
const crewKey = job => JSON.stringify([crewPeople(job).map(([key]) => key), typeof job?.crewId === 'string' && job.crewId ? job.crewId : null, typeof job?.crewLead === 'string' && job.crewLead ? job.crewLead.trim().toLowerCase() : null]);

/** What a schedule change tells HighLevel's second record, or null: 'scheduled' (booked, first placed or restored),
 * 'rescheduled' (a new start or end), 'crew_assigned' (only the crew, crew lead or estimator changed), 'cancelled' or
 * 'no_show' (of a visit that had a time). Blocks, unscheduled and finished visits tell it nothing. */
export function scheduleMirrorEvent(before, after, action) {
  if (!object(after) || !visitKind(after.type) || after.recordType) return null;
  const now = state(after), then = before ? state(before) : '', previous = startOf(before);
  if (CANCELLED.has(now)) return CANCELLED.has(then) || !previous ? null : 'cancelled';
  if (NO_SHOW.has(now)) return NO_SHOW.has(then) || !previous ? null : 'no_show';
  const start = startOf(after);
  if (FINISHED.has(now) || !start) return null;
  if (action === 'schedule.restore' || !previous || CANCELLED.has(then) || NO_SHOW.has(then)) return 'scheduled';
  if (previous !== start || scheduleInterval(before)?.endAt !== scheduleInterval(after)?.endAt) return 'rescheduled';
  return crewKey(before) !== crewKey(after) ? 'crew_assigned' : null;
}

const LABELS = {
  scheduled: { walkthrough: 'Walkthrough booked', job: 'Job scheduled' },
  rescheduled: { walkthrough: 'Walkthrough rescheduled', job: 'Job rescheduled' },
  crew_assigned: { walkthrough: 'Estimator assigned', job: 'Crew assigned' },
  cancelled: { walkthrough: 'Walkthrough cancelled', job: 'Job cancelled' },
  no_show: { walkthrough: 'Walkthrough no-show', job: 'Job no-show' },
};
const DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const CLOCK = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: 'numeric', minute: '2-digit' });
const spaced = text => text.replace(/[  ]/g, ' ');

/** The visit's date and its Denver time window, as a note reads them. */
export function denverWindow(job) {
  const interval = scheduleInterval(job);
  if (!interval) return { date: 'Not scheduled', time: '' };
  const start = new Date(interval.startAt), end = new Date(interval.endAt), day = spaced(DAY.format(start)), endDay = spaced(DAY.format(end));
  return { date: day, time: `${spaced(CLOCK.format(start))} – ${endDay === day ? '' : `${endDay} `}${spaced(CLOCK.format(end))} (Denver time)` };
}

function crewLine(job, roster, resources) {
  const names = new Map((Array.isArray(roster) ? roster : []).filter(person => object(person) && typeof person.id === 'string').map(person => [person.id.trim().toLowerCase(), clip(person.name || person.id, 80)]));
  const lead = typeof job.crewLead === 'string' ? job.crewLead.trim().toLowerCase() : '';
  const people = crewPeople(job).map(([key, raw]) => `${names.get(key) || clip(raw, 80)}${key === lead ? ' (lead)' : ''}`);
  const crew = typeof job.crewId === 'string' && job.crewId ? (Array.isArray(resources) ? resources : []).find(row => object(row) && row.recordType === 'crew' && row.id === job.crewId) : null;
  const label = crew?.name ? clip(crew.name, 100) : '';
  if (!people.length) return label ? `${label} (nobody assigned yet)` : 'Not assigned yet';
  return `${label ? `${label}: ` : ''}${people.join(', ')}`;
}

// The job breakdown the visit already carries (the estimator's handoff or Dispatch): never prices or customer contact details.
function breakdown(job) {
  const lines = [], service = typeof job.serviceType === 'string' && job.serviceType.trim() ? job.serviceType : typeof job.title === 'string' ? job.title : '';
  if (service.trim()) lines.push(`Service: ${clip(service, 160)}`);
  const instructions = job.jobInstructions, scope = typeof job.operationalScope?.text === 'string' ? job.operationalScope.text : typeof instructions === 'string' ? instructions
    : typeof instructions?.operationalScope === 'string' ? instructions.operationalScope : typeof job.scopeOfWork === 'string' ? job.scopeOfWork : typeof job.scope === 'string' ? job.scope : '';
  if (scope.trim()) lines.push(`Scope: ${clip(scope, 600)}`);
  if (object(instructions)) {
    for (const [key, label] of [['keepItems', 'Keep'], ['removeItems', 'Remove'], ['hazards', 'Hazards']]) {
      const value = Array.isArray(instructions[key]) ? instructions[key].filter(item => typeof item === 'string').join(', ') : typeof instructions[key] === 'string' ? instructions[key] : '';
      if (value.trim()) lines.push(`${label}: ${clip(value, 300)}`);
    }
  }
  // The signed walkthrough's job breakdown (job-breakdown.js: its summary, else the crew brief's copy of its lines), in
  // the quote builder's order: one "Removal: …", "Shelving: …", "Storage: …", "Cleaning: …" line each.
  const summary = typeof job.jobBreakdown?.summary === 'string' ? job.jobBreakdown.summary.split('\n')
    : object(instructions) && Array.isArray(instructions.jobBreakdown) ? instructions.jobBreakdown : [];
  const sections = summary.filter(line => typeof line === 'string' && line.trim()).slice(0, 8).map(line => clip(line, 400));
  if (sections.length) lines.push('Job breakdown:', ...sections);
  const crewSize = Number(job.crewNeeded ?? job.requiredCrewSize);
  if (Number.isInteger(crewSize) && crewSize > 0) lines.push(`Crew size: ${crewSize}`);
  const minutes = Number(job.estimatedDurationMin ?? job.durationMin);
  if (Number.isFinite(minutes) && minutes > 0) lines.push(`Estimated time on site: ${Math.round(minutes)} minutes`);
  const materials = (Array.isArray(job.materials) ? job.materials : []).filter(item => object(item) && typeof item.name === 'string' && item.name.trim()).slice(0, 20)
    .map(item => `${clip(item.name, 80)}${Number.isFinite(Number(item.quantity)) && Number(item.quantity) > 0 ? ` x ${Number(item.quantity)}` : ''}`);
  if (materials.length) lines.push(`Materials (buy or load for the crew): ${materials.join('; ')}`);
  const equipment = (Array.isArray(job.requiredEquipment) ? job.requiredEquipment : []).filter(value => typeof value === 'string' && value.trim()).slice(0, 20).map(value => clip(value, 80));
  if (equipment.length) lines.push(`Equipment: ${equipment.join('; ')}`);
  return lines;
}

/** The internal contact note for one change: {title, body}. */
export function scheduleMirrorNote({ kind, job, roster = [], resources = [] }) {
  const visit = visitKind(job?.type) || 'job', label = LABELS[kind]?.[visit] || 'Schedule updated', when = denverWindow(job);
  const lines = [`EGC SCHEDULE UPDATE: ${label}`, `Date: ${when.date}`, ...(when.time ? [`Time: ${when.time}`] : []),
    `${visit === 'walkthrough' ? 'Estimator' : 'Crew'}: ${crewLine(job, roster, resources)}`, `Address: ${clip(job.address || 'Not recorded', 300)}`,
    ...breakdown(job), ...(kind === 'cancelled' || kind === 'no_show' ? [`Status: ${kind === 'cancelled' ? 'cancelled' : 'no-show'} in the EGC Hub`] : []),
    '', 'Internal note from the EGC Hub, which keeps the schedule. The Hub sent the customer nothing.'];
  return { title: `EGC schedule: ${label}`, body: lines.join('\n').slice(0, 3000) };
}

/** A door-to-door job's attribution, or null: the Knock bridge's source 'door_to_door' with d2d.kind 'sale' or
 * 'walkthrough'. repKey is '' when it is not a rep key; tags are the job's ghlTags that are D2D tags (nothing else). */
export function d2dAttribution(job) {
  const d2d = object(job?.d2d) ? job.d2d : null;
  if (job?.source !== 'door_to_door' || !d2d || !Object.hasOwn(GHL_D2D_TAGS, d2d.kind)) return null;
  const carried = Array.isArray(job.ghlTags) ? job.ghlTags : [];
  return { kind: d2d.kind, repKey: typeof d2d.repKey === 'string' && REP_KEY.test(d2d.repKey) ? d2d.repKey : '', tags: D2D_TAG_LIST.filter(tag => carried.includes(tag)) };
}
// A door sale's signed price (knock-bridge.js d2d.ticket): its deal's value while the Hub job has no price of its own
// (Knock collects a door sale's money, so the bridge never makes it a Hub price).
const doorTicket = job => job?.source === 'door_to_door' && object(job.d2d) && job.d2d.kind === 'sale' ? job.d2d.ticket : undefined;
/** The note's door-to-door line: who brought the customer in, by first name only. */
export const d2dNoteLine = (kind, firstName) => `Door to door: ${kind === 'sale' ? 'sale' : 'walkthrough'} set by ${firstName || 'a door-to-door rep'}`;
// The line goes right under the note's heading (the first line), so it reads before the schedule details.
const withLine = (body, line) => { const lines = String(body).split('\n'); lines.splice(1, 0, line); return lines.join('\n'); };
const firstNameOf = name => clip(String(name ?? '').trim().split(/\s+/)[0], 40);
// The rep's first name from their canvassing profile (knock_reps), read once per drain pass; '' when there is none.
async function repFirstName(store, run, repKey) {
  if (!repKey) return '';
  if (!run.reps.has(repKey)) { const rep = await store.read('knock_reps', repKey); run.reps.set(repKey, firstNameOf(rep?.displayName || rep?.username)); }
  return run.reps.get(repKey);
}

/** The mirror entry a schedule change commits with, as a list of writes ([] with the flag off or nothing to tell).
 * The writer passes its store (store.ghlScheduleMirror carries the flag), the visit before and after the change, its
 * request id and, for the note, the roster and dispatch resources it already holds. */
export async function scheduleMirrorWrites(store, { jobId, before = null, after, action, requestId, now, source = 'dispatch', roster = [], resources = [] } = {}) {
  if (after?.ownerWalkthrough?.providerWrites === 'blocked') return [];
  if (store?.ghlScheduleMirror !== true) return [];
  const kind = scheduleMirrorEvent(before, after, action);
  if (!kind || !safeId(jobId) || typeof requestId !== 'string' || !requestId || typeof now !== 'string') return [];
  const job = { ...after, id: jobId }, visit = visitKind(job.type), active = kind !== 'cancelled' && kind !== 'no_show';
  const changeKey = scheduleMirrorChangeKey(source, requestId), id = await scheduleMirrorEntryId(jobId, changeKey);
  // A writer that adds fields to the visit after Dispatch's patch (the signed walkthrough handoff adds the job breakdown
  // and time on site in its commit, walkthrough-handoff.js) names them on its store, so the note reads the visit as saved.
  const facts = object(store.scheduleMirrorFacts) ? store.scheduleMirrorFacts : {};
  return [{ collection: GHL_SCHEDULE_MIRROR, id, patch: {
    id, jobId, changeKey, kind, visitType: visit, stage: active ? GHL_MIRROR_STAGES[visit] : null, projectKey: projectKeyOf(job),
    customerId: safeId(job.customerId) ? job.customerId : '', estimatorId: walkthroughEstimator(job), note: scheduleMirrorNote({ kind, job: { ...job, ...facts }, roster, resources }),
    expect: active ? { state: 'active', startAt: startOf(job), crew: crewKey(job) } : { state: kind },
    source, requestId: requestId.toLowerCase(), createdAt: now, attempts: 0, nextAttemptAt: now, status: 'pending',
  } }];
}

/** Pending, not backing off and not claimed by another attempt. `at` is ms. */
export function ghlMirrorDue(entry, at) {
  if (entry?.status !== 'pending') return false;
  return !(ms(entry.nextAttemptAt) > at) && !(ms(entry.claimedUntil) > at);
}
/** Due for more than GHL_MIRROR_OVERDUE_MINUTES and still not attempted: the drain is not running. */
export function ghlMirrorOverdue(entry, at) {
  if (!ghlMirrorDue(entry, at)) return false;
  const next = ms(entry.nextAttemptAt), since = Number.isFinite(next) ? next : ms(entry.createdAt);
  return Number.isFinite(since) && at - since > GHL_MIRROR_OVERDUE_MINUTES * 60000;
}

// The change is still what the visit shows: the same start and crew, still active; or still cancelled or a no-show.
function stillCurrent(entry, job) {
  const expect = object(entry.expect) ? entry.expect : {}, now = state(job);
  if (expect.state === 'active') return !CANCELLED.has(now) && !NO_SHOW.has(now) && !FINISHED.has(now) && startOf(job) === expect.startAt && crewKey(job) === expect.crew;
  if (expect.state === 'cancelled') return CANCELLED.has(now);
  if (expect.state === 'no_show') return NO_SHOW.has(now);
  return false;
}
// The stage the visit as it is NOW calls for: an active, scheduled walkthrough or job; else none.
function currentStage(job) {
  const kind = visitKind(job?.type), now = state(job);
  return kind && !job.recordType && !CANCELLED.has(now) && !NO_SHOW.has(now) && !FINISHED.has(now) && startOf(job) ? GHL_MIRROR_STAGES[kind] : null;
}
const SUPERSEDED_LINE = 'Replaced: the Hub changed this visit again after this update. The Hub has the current schedule.';

// HighLevel's own refusals are highlevel_<status>; a storage failure mid-attempt keeps pointing at storage.
function failureCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (/^ghl_mirror_[a-z_]+$/.test(code)) return code;
  if (/^[a-z]+_[a-z0-9_]+$/.test(code)) return 'ghl_mirror_storage_unavailable';
  return Number.isInteger(error?.status) ? `highlevel_${error.status}` : 'highlevel_unreachable';
}

async function settle(store, claimed, patch, outcome, extra = []) {
  try { await store.commit([{ collection: GHL_SCHEDULE_MIRROR, id: claimed.id, revision: claimed.revision, patch: { ...patch, claimId: '', claimedUntil: '' } }, ...extra]); return outcome; }
  catch { return 'busy'; }
}

// The pipeline's stage ids in board order, read once per drain pass.
async function pipelineStages(run) {
  if (!run.stages) {
    const data = await run.ghl(`/opportunities/pipelines?locationId=${encodeURIComponent(run.c.locationId)}`);
    const pipeline = (Array.isArray(data?.pipelines) ? data.pipelines : []).find(row => object(row) && row.id === run.pipeline.pipelineId);
    const stages = (Array.isArray(pipeline?.stages) ? pipeline.stages : []).filter(stage => object(stage) && typeof stage.id === 'string' && stage.id);
    run.stages = (stages.every(stage => Number.isFinite(stage.position)) ? [...stages].sort((a, b) => a.position - b.position) : stages).map(stage => stage.id);
  }
  return run.stages;
}

async function estimatorUser(run, entry, job) {
  if (entry.visitType !== 'walkthrough') return null;
  const key = walkthroughEstimator(job);
  if (!key) return null;
  if (!run.users.has(key)) run.users.set(key, await estimatorHighLevelUserId(run.env, job, run.readProfile ? { read: run.readProfile } : {}));
  return run.users.get(key);
}

const SEARCH_LIMIT = 100;
const review = detail => ({ outcome: 'needs_link', review: true, detail });
/** Step 2: the customer job's one opportunity, moved forward to `stage`. Returns {outcome, opportunityId?, from?, linkPatch?},
 * or {review, detail} when a person has to decide in HighLevel. */
async function mirrorOpportunity(store, run, { entry, job, stage, contactId, link, linkId, now, d2d = null }) {
  const { c, pipeline } = run, target = stage === GHL_MIRROR_STAGES.walkthrough ? pipeline.walkthroughStageId : pipeline.jobScheduledStageId;
  if (!pipeline.pipelineId || !target) return { outcome: 'not_configured' };
  const stages = await pipelineStages(run), rank = id => stages.indexOf(id);
  if (rank(target) < 0) return { outcome: 'not_configured' };
  const assignee = await estimatorUser(run, entry, job);
  const name = clip([job.customer, job.serviceType || (entry.visitType === 'walkthrough' ? 'Walkthrough' : 'Garage service')].filter(Boolean).join(' - '), 200) || 'EGC Garage Service';
  let opportunity = null;
  const linkedId = typeof link?.opportunityId === 'string' && link.opportunityId ? link.opportunityId : typeof job.highlevelOpportunityId === 'string' ? job.highlevelOpportunityId : '';
  if (linkedId) {
    let found = null;
    try { const data = await run.ghl(opportunityPath(linkedId)); found = object(data?.opportunity) ? data.opportunity : data; }
    catch (error) { if (error?.status !== 404) throw error; }
    if (found?.id === linkedId) {
      // A link to another person's deal or another pipeline is never moved and never replaced by a guess.
      if ((found.contactId || found.contact?.id) !== contactId || found.pipelineId !== pipeline.pipelineId) return review('linked_elsewhere');
      opportunity = found;
    }
  }
  if (!opportunity) {
    // Every status, not only open (web-lead-intake.js, docs/WEB-LEAD-SAFETY.md): a contact with any deal in the pipeline,
    // open or closed, never gets a new one here. Its one open deal is used; several open ones, or only closed ones (a
    // repeat customer whose last job is won or lost), wait for a person. Empty means an empty list AND a total of 0.
    const params = new URLSearchParams({ locationId: c.locationId, contactId, pipelineId: pipeline.pipelineId, status: 'all', limit: String(SEARCH_LIMIT), page: '1' });
    const found = await run.ghl(`/opportunities/search?${params}`), rows = found?.opportunities, total = found?.meta?.total;
    if (!Array.isArray(rows) || rows.some(row => !object(row))) throw fail('ghl_mirror_opportunity_search_unverified', 'HighLevel returned no opportunity list.', 502);
    if (rows.length >= SEARCH_LIMIT || Number(total || 0) > rows.length) return review('too_many');
    const deals = rows.filter(row => (row.contactId || row.contact?.id) === contactId && row.pipelineId === pipeline.pipelineId), open = deals.filter(row => row.status === 'open');
    if (open.length > 1) return review('several_open');
    if (open.length === 1) opportunity = open[0];
    else if (deals.length) return review('closed_only');
    else {
      if (!rows.length && total !== 0 && total !== '0') throw fail('ghl_mirror_opportunity_search_unverified', 'HighLevel did not confirm that the contact has no opportunity.', 502);
      // Only one attempt creates a customer job's opportunity: the link record is claimed first (compare-and-set).
      // A claim another attempt holds waits its turn; an abandoned one is found again by the search above.
      if (link?.creatingEntryId && link.creatingEntryId !== entry.id && ms(link.creatingUntil) > Date.parse(now)) throw fail('ghl_mirror_opportunity_busy', 'Another schedule change is creating this customer job\'s opportunity.', 409);
      try { await store.commit([{ collection: GHL_SCHEDULE_MIRROR_LINKS, id: linkId, revision: link?.revision, patch: { id: linkId, projectKey: entry.projectKey, contactId, creatingEntryId: entry.id, creatingUntil: iso(Date.parse(now) + GHL_MIRROR_CLAIM_MINUTES * 60000), updatedAt: now } }]); }
      catch { throw fail('ghl_mirror_opportunity_busy', 'Another schedule change is creating this customer job\'s opportunity.', 409); }
      const amount = Number(job.total ?? job.priceQuoted ?? doorTicket(job));
      // Create-only, never upsert: a deal created or closed after the search above is never reopened or reset by this.
      const body = { pipelineId: pipeline.pipelineId, locationId: c.locationId, name, pipelineStageId: target, status: 'open', contactId,
        monetaryValue: entry.visitType === 'job' && Number.isFinite(amount) && amount > 0 ? amount : 0, assignedTo: assignee || c.userId || undefined,
        // A door-to-door customer's new deal says where it came from; only here, at create (a move never sends a source).
        ...(d2d ? { source: GHL_D2D_SOURCE } : {}) };
      const create = (payload, key) => run.ghl('/opportunities/', { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(payload) });
      let created, source = d2d ? 'set' : null;
      try { created = await create(body, `egc-schedule-mirror:${entry.projectKey}`); }
      catch (error) {
        // HighLevel refused the source field itself: the deal is still created, without it (a refusal created nothing,
        // so the plain create has its own key). Any other refusal is the attempt's failure, as before.
        if (!d2d || ![400, 422].includes(error?.status) || !/source/i.test(String(error?.detail || ''))) throw error;
        const plain = { ...body };
        delete plain.source;
        created = await create(plain, `egc-schedule-mirror:${entry.projectKey}:plain`);
        source = 'refused';
      }
      const createdId = created?.opportunity?.id || created?.id || '';
      if (typeof createdId !== 'string' || !createdId) throw fail('ghl_mirror_opportunity_unconfirmed', 'HighLevel returned no opportunity id.', 502);
      return { outcome: 'created', opportunityId: createdId, ...(source ? { source } : {}), linkPatch: { opportunityId: createdId, creatingEntryId: '', creatingUntil: '' } };
    }
  }
  const id = opportunity.id, current = opportunity.pipelineStageId || '', linkPatch = { opportunityId: id };
  // Only an opportunity HighLevel says is open moves (a won, lost, abandoned or unstated status stays where it is).
  if (opportunity.status !== 'open') return { outcome: 'closed', opportunityId: id, linkPatch };
  if (current === target) return { outcome: 'at_stage', opportunityId: id, linkPatch };
  if (rank(current) < 0) return { outcome: 'stage_unknown', opportunityId: id, linkPatch };
  if (rank(current) > rank(target)) return { outcome: 'later_stage', opportunityId: id, linkPatch };
  const value = Number(opportunity.monetaryValue);
  // No status in the move: a deal closed in HighLevel since the read above is never reopened by it.
  await run.ghl(opportunityPath(id), { method: 'PUT', body: JSON.stringify({ pipelineId: pipeline.pipelineId, name: opportunity.name || name, pipelineStageId: target,
    monetaryValue: Number.isFinite(value) ? value : 0, ...(assignee ? { assignedTo: assignee } : {}) }) });
  return { outcome: 'moved', opportunityId: id, from: current, linkPatch };
}

async function deliver(store, run, entry, now, claim) {
  const at = Date.parse(now), attempts = count(entry.attempts);
  if (attempts >= GHL_MIRROR_PARK_ATTEMPTS) return settle(store, entry, { status: 'parked', lastError: entry.lastError || 'ghl_mirror_attempts_exhausted' }, 'parked');
  try { await store.commit([{ collection: GHL_SCHEDULE_MIRROR, id: entry.id, revision: entry.revision, patch: { claimId: claim, claimedUntil: iso(at + GHL_MIRROR_CLAIM_MINUTES * 60000), attempts: attempts + 1, lastAttemptAt: now } }]); }
  catch { return 'busy'; }
  const claimed = await store.read(GHL_SCHEDULE_MIRROR, entry.id).catch(() => null);
  if (claimed?.claimId !== claim) return 'busy';
  const steps = object(claimed.steps) ? { ...claimed.steps } : {}, links = [];
  let review = '';
  try {
    const job = await store.read('jobs', claimed.jobId);
    if (!job) return settle(store, claimed, { status: 'done', doneAt: now, skipped: 'job_missing', lastError: '' }, 'skipped');
    // Door to door: read from the visit (the bridge commits its attribution with the job, after this entry was built).
    const d2d = d2dAttribution(job);
    // A change the visit has moved past is still told: its own note, marked as replaced. Its stage step follows the visit
    // as it is NOW (forward only), so a later change, or one that queued no entry (a crew self-claim), never leaves the
    // deal behind. A replaced cancellation or no-show moves no stage.
    const superseded = !stillCurrent(claimed, job), stage = superseded ? claimed.stage ? currentStage(job) : null : claimed.stage;
    const linkId = await scheduleMirrorLinkId(claimed.projectKey || `visit_${claimed.jobId}`), link = await store.read(GHL_SCHEDULE_MIRROR_LINKS, linkId);
    let contactId = typeof steps.contactId === 'string' && steps.contactId ? steps.contactId : job.highlevelContactId || (safeId(job.customerId) ? (await store.read('customers', job.customerId))?.highlevelContactId : '') || link?.contactId || '';
    if (!contactId) {
      // GHL-ALIGN: a messaging dry run (EGC_MESSAGING_DRY_RUN unless exactly "false") never creates a HighLevel contact. A visit the
      // Hub never mirrors (Dispatch's 'not_needed': no contact, no appointment) has nothing to tell, as with the tag outbox.
      if (run.env.EGC_MESSAGING_DRY_RUN !== 'false') {
        if (job.syncStatus === 'not_needed') return settle(store, claimed, { status: 'done', doneAt: now, skipped: 'contact_not_linked', steps, lastError: '' }, 'skipped');
        throw fail('ghl_mirror_contact_not_linked', 'The visit has no linked HighLevel contact yet.', 409);
      }
      contactId = await ensureContact(run.c, { name: job.customer || '', phone: job.phone || '', email: job.email || '', address: job.address || '' }, d2d ? GHL_D2D_SOURCE : 'EGC Hub schedule');
      if (!contactId) throw fail('ghl_mirror_contact_unresolved', 'HighLevel returned no contact.', 502);
    }
    steps.contactId = contactId;
    if (stage && !steps.opportunity) {
      const result = await mirrorOpportunity(store, run, { entry: claimed, job, stage, contactId, link, linkId, now, d2d });
      if (result.review) { review = GHL_MIRROR_NEEDS_LINK; steps.opportunityReview = result.detail; }
      else {
        delete steps.opportunityReview;
        steps.opportunity = result.outcome;
        if (result.opportunityId) steps.opportunityId = result.opportunityId;
        if (result.from !== undefined) steps.opportunityFrom = result.from;
        if (result.source) steps.opportunitySource = result.source;
        if (result.linkPatch) {
          const latest = await store.read(GHL_SCHEDULE_MIRROR_LINKS, linkId);
          links.push({ collection: GHL_SCHEDULE_MIRROR_LINKS, id: linkId, revision: latest?.revision, patch: { id: linkId, projectKey: claimed.projectKey, contactId, ...result.linkPatch, updatedAt: now } });
        }
      }
    }
    if (!steps.note) {
      const note = object(claimed.note) ? claimed.note : {}, title = String(note.title || 'EGC schedule update');
      const body = d2d ? withLine(String(note.body || ''), d2dNoteLine(d2d.kind, await repFirstName(store, run, d2d.repKey))) : String(note.body || '');
      steps.note = await addContactNote(run.c, contactId, { title: (superseded ? `${title} (since changed)` : title).slice(0, 200), body: (superseded ? `${SUPERSEDED_LINE}\n${body}` : body).slice(0, 3000), idempotencyKey: claimed.id }) || now;
    }
    // EGC_GHL_D2D_TAGS: a door-to-door job's own tag, once (its booking or restore, kind 'scheduled'), and only while the
    // visit is active (a stage to move to): a visit cancelled before HighLevel heard of it starts no tag workflow.
    if (run.d2dTags && d2d?.tags.length && claimed.kind === 'scheduled' && stage && !steps.tags) {
      await addTags(run.c, contactId, d2d.tags);
      steps.tags = d2d.tags;
    }
    // A customer job with several open opportunities, only closed ones, or a link to someone else's, waits for a person:
    // the note is written, the stage is not guessed. A manager's Retry, once HighLevel is tidied, tries the stage again.
    const replaced = superseded ? { superseded: true } : {};
    if (review) return settle(store, claimed, { status: 'parked', steps, lastError: review, ...replaced }, 'parked', links);
    const outcome = await settle(store, claimed, { status: 'done', doneAt: now, steps, lastError: '', ...replaced }, 'done', links);
    // A lost link write (another attempt touched the record) never undoes the delivery: the next search finds the deal again.
    return outcome === 'busy' && links.length ? settle(store, claimed, { status: 'done', doneAt: now, steps, lastError: '', ...replaced }, 'done') : outcome;
  } catch (error) {
    const tries = attempts + 1, park = tries >= GHL_MIRROR_PARK_ATTEMPTS;
    return settle(store, claimed, { status: park ? 'parked' : 'pending', nextAttemptAt: iso(at + ghlMirrorBackoffMinutes(tries) * 60000), lastError: failureCode(error), steps }, park ? 'parked' : 'retrying', links);
  }
}

/** One drain pass: the named entries (a save's first attempt, a manager's retry) or the due queue, oldest first, at most
 * `limit`. Returns counts only. `now` is an ISO string; `fetcher` reaches HighLevel; `readProfile(collection, id)` reads
 * a staff profile (tests; else the encrypted staff vault). */
export async function drainScheduleMirror(store, { env = {}, now = new Date().toISOString(), ids = null, limit = GHL_MIRROR_DRAIN_LIMIT, fetcher = fetch, claimId = () => crypto.randomUUID(), readProfile = null } = {}) {
  const summary = { due: 0, attempted: 0, done: 0, retrying: 0, parked: 0, skipped: 0, busy: 0, truncated: false };
  const c = highLevelConfig(env);
  if (!c.token || !c.locationId) return { ...summary, code: 'ghl_mirror_highlevel_not_configured' };
  c.fetch = (url, init = {}) => fetcher(url, { ...init, signal: AbortSignal.timeout(15000) });
  const run = { c, env, pipeline: schedulePipeline(env), stages: null, users: new Map(), reps: new Map(), d2dTags: ghlD2dTagsEnabled(env), readProfile, ghl: (path, options) => ghl(c, path, options) };
  let rows;
  if (Array.isArray(ids)) rows = (await Promise.all([...new Set(ids)].filter(id => ENTRY_ID.test(id)).map(id => store.read(GHL_SCHEDULE_MIRROR, id)))).filter(Boolean);
  else { const due = await store.due(); rows = due.rows; summary.truncated = due.truncated === true; }
  const at = Date.parse(now), queue = rows.filter(entry => ghlMirrorDue(entry, at))
    .sort((a, b) => String(a.nextAttemptAt || '').localeCompare(String(b.nextAttemptAt || '')) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id));
  summary.due = queue.length;
  for (const entry of queue.slice(0, Math.max(0, limit))) {
    const outcome = await deliver(store, run, entry, now, claimId());
    summary[outcome]++;
    if (outcome !== 'busy') summary.attempted++;
  }
  return summary;
}

/** The first attempt after a save, in the background (ctx.waitUntil), so the save's response never waits on HighLevel.
 * False when the flag is off or there is no waitUntil: the worker's next tick attempts it instead. */
export function firstScheduleMirrorAttempt({ env, waitUntil } = {}, ids = [], now = new Date().toISOString(), storage = scheduleMirrorStorage) {
  const named = (Array.isArray(ids) ? ids : []).filter(id => ENTRY_ID.test(id || ''));
  if (!ghlScheduleMirrorEnabled(env) || typeof waitUntil !== 'function' || !named.length) return false;
  waitUntil(Promise.resolve().then(() => drainScheduleMirror(storage(env), { env, now, ids: named })).catch(() => null));
  return true;
}

/** The first attempt for one saved change, by the id its writer derived (a dispatch or bridge save that knows only the
 * visit and its request id). An entry that was never queued (nothing to tell) is simply not found. */
export async function firstScheduleMirrorAttemptFor(context, jobId, requestId, now = new Date().toISOString(), source = 'dispatch', storage = scheduleMirrorStorage) {
  if (!ghlScheduleMirrorEnabled(context?.env) || !safeId(jobId) || typeof requestId !== 'string' || !requestId) return false;
  return firstScheduleMirrorAttempt(context, [await scheduleMirrorEntryId(jobId, scheduleMirrorChangeKey(source, requestId))], now, storage);
}

/** The entry ids a commit's writes carry (for firstScheduleMirrorAttempt). */
export const scheduleMirrorIds = writes => (Array.isArray(writes) ? writes : []).filter(write => write?.collection === GHL_SCHEDULE_MIRROR && ENTRY_ID.test(write.id || '')).map(write => write.id);

// Parked entries never expire, so production counts them (a count aggregation: about one read per 1000 entries) rather
// than reading them; a store without parkedCounts (tests) counts its rows.
async function parkedCounts(store) {
  if (typeof store.parkedCounts === 'function') return store.parkedCounts();
  const { rows, truncated } = await store.parked(), parked = rows.filter(row => row.status === 'parked');
  return { parked: parked.length, needsLink: parked.filter(row => row.lastError === GHL_MIRROR_NEEDS_LINK).length, complete: truncated !== true };
}

/** The Integrations screen's view: parked entries (they need a manager; counted, never read) and pending ones the drain
 * is overdue on (the worker has stopped; at most GHL_MIRROR_STATUS_SCAN_LIMIT pending entries are read), plus the signed
 * drain worker's last check-in (shared with the tag outbox). Counts only, never a visit, contact or note. `now` is ISO. */
export async function scheduleMirrorStatus(store, now) {
  const at = Date.parse(now), [parked, pending, beat] = await Promise.all([parkedCounts(store), store.due(GHL_MIRROR_STATUS_SCAN_LIMIT), store.read(GHL_TAG_DRAIN_STATE, GHL_TAG_DRAIN_STATE_ID).catch(() => null)]);
  const rows = pending.rows.filter(row => row.status === 'pending');
  return { enabled: true, parked: parked.parked, needsLink: parked.needsLink, overdue: rows.filter(row => ghlMirrorOverdue(row, at)).length, pending: rows.length,
    drain: ghlTagDrainView(beat, at), complete: parked.complete !== false && pending.truncated !== true, asOf: now };
}

/** A manager's Retry: parked entries and pending ones the drain is overdue on (all, or one visit's) are due now with a
 * fresh budget of attempts; the caller gives them one attempt at once (waitUntil). */
export async function retryScheduleMirror(store, session, input, now, env) {
  if (!session) throw fail('ghl_mirror_sign_in_required', 'Sign in to the Employee Hub to retry the HighLevel schedule mirror.', 401);
  if (!canDispatch(session, env)) throw fail('ghl_mirror_forbidden', 'Only an operations manager or owner can retry the HighLevel schedule mirror.', 403);
  if (!object(input) || Object.keys(input).some(key => !['action', 'requestId', 'jobId'].includes(key)) || input.action !== 'retry' || !UUID.test(input.requestId || '') || (input.jobId !== undefined && !safeId(input.jobId))) throw fail('ghl_mirror_request_invalid', 'Send retry with a unique request ID and, optionally, one visit.');
  const at = Date.parse(now), [parked, pending] = await Promise.all([store.parked(), store.due()]), ids = [];
  const rows = [...parked.rows.filter(row => row.status === 'parked'), ...pending.rows.filter(row => ghlMirrorOverdue(row, at))];
  for (const row of rows.filter(row => !input.jobId || row.jobId === input.jobId).slice(0, 50)) {
    try {
      await store.commit([{ collection: GHL_SCHEDULE_MIRROR, id: row.id, revision: row.revision, patch: { status: 'pending', attempts: 0, nextAttemptAt: now, lastError: '', claimId: '', claimedUntil: '', retriedAt: now, retriedBy: String(session.user || ''), retryRequestId: input.requestId.toLowerCase() } }]);
      ids.push(row.id);
    } catch (error) { if (error?.status !== 409) throw error; }
  }
  return { ok: true, requestId: input.requestId, requeued: ids.length, ids };
}

function decodeRow(document) {
  const prefix = `${ROOT}/${GHL_SCHEDULE_MIRROR}/`, name = document?.name;
  const id = typeof name === 'string' && name.startsWith(prefix) ? name.slice(prefix.length) : '';
  if (!ENTRY_ID.test(id) || typeof document.updateTime !== 'string' || !document.updateTime || document.fields !== undefined && !object(document.fields)) throw fail('ghl_mirror_storage_incomplete', 'The HighLevel schedule mirror returned an unreadable entry.', 503);
  return { ...decodeFirestoreFields(document.fields || {}), id, revision: document.updateTime };
}

/** Production store: dispatch storage reads and commits, plus the pending and parked queues (a single-field status
 * query) and the parked counts (count aggregations on equality filters only, so no composite index). An unreadable or
 * malformed answer is never an empty queue or a zero count. The flag rides on the store for the writers. */
export function scheduleMirrorStorage(env, fetcher = firestoreFetch) {
  const dispatch = dispatchStorage(env, fetcher);
  async function count(filters) {
    const where = filters.length === 1 ? { fieldFilter: filters[0] } : { compositeFilter: { op: 'AND', filters: filters.map(fieldFilter => ({ fieldFilter })) } };
    const query = { structuredAggregationQuery: { structuredQuery: { from: [{ collectionId: GHL_SCHEDULE_MIRROR }], where }, aggregations: [{ alias: 'count', count: {} }] } };
    let response;
    try { response = await fetcher(env, `${BASE}:runAggregationQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query), signal: AbortSignal.timeout(15000) }); }
    catch { throw fail('ghl_mirror_storage_unavailable', 'The HighLevel schedule mirror could not be counted.', 503); }
    if (!response.ok) throw fail('ghl_mirror_storage_unavailable', 'The HighLevel schedule mirror could not be counted.', 503);
    try { return aggregateCount(await response.json()).count; } catch { throw fail('ghl_mirror_storage_incomplete', 'The HighLevel schedule mirror returned an unreadable count.', 503); }
  }
  async function byStatus(status, limit = GHL_MIRROR_SCAN_LIMIT) {
    const query = { structuredQuery: { from: [{ collectionId: GHL_SCHEDULE_MIRROR }], where: { fieldFilter: equals('status', status) }, limit: limit + 1 } };
    let response, rows;
    try { response = await fetcher(env, `${BASE}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query), signal: AbortSignal.timeout(15000) }); }
    catch { throw fail('ghl_mirror_storage_unavailable', 'The HighLevel schedule mirror could not be read.', 503); }
    if (!response.ok) throw fail('ghl_mirror_storage_unavailable', 'The HighLevel schedule mirror could not be read.', 503);
    try { rows = await response.json(); } catch { throw fail('ghl_mirror_storage_incomplete', 'The HighLevel schedule mirror returned an unreadable answer.', 503); }
    if (!Array.isArray(rows) || rows.some(row => !object(row))) throw fail('ghl_mirror_storage_incomplete', 'The HighLevel schedule mirror returned an unreadable answer.', 503);
    const documents = rows.filter(row => row.document).map(row => decodeRow(row.document)).filter(row => row.status === status);
    return { rows: documents.slice(0, limit), truncated: documents.length > limit };
  }
  async function parkedTotals() {
    const parked = await count([equals('status', 'parked')]);
    return { parked, needsLink: parked ? await count([equals('status', 'parked'), equals('lastError', GHL_MIRROR_NEEDS_LINK)]) : 0, complete: true };
  }
  return { ghlScheduleMirror: ghlScheduleMirrorEnabled(env), read: (collection, id) => dispatch.read(collection, id), commit: writes => dispatch.commit(writes),
    due: limit => byStatus('pending', Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, GHL_MIRROR_SCAN_LIMIT) : GHL_MIRROR_SCAN_LIMIT), parked: () => byStatus('parked'), parkedCounts: parkedTotals };
}
