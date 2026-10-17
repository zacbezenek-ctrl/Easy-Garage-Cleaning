/* D9/D9b: the HighLevel schedule mirror (EGC_GHL_SCHEDULE_MIRROR). The Hub keeps the schedule; HighLevel is a
   second record and must not depend on a calendar. With the flag exactly "true", a Hub schedule change that matters
   (a walkthrough booked, a job scheduled, moved, cancelled or marked a no-show, a crew or estimator assigned) writes
   ONE ghlScheduleMirror entry in the SAME Firestore commit as the change (scheduleMirrorWrites: the id is derived from
   the visit and its change key, created once). The API that saved it may make the first attempt after its response
   (firstScheduleMirrorAttempt, ctx.waitUntil); the signed /api/ghl-tag-drain tick (egc-worker, every 2 minutes)
   retries it. An attempt claims the entry first (compare-and-set) and re-reads the visit: a change the visit has
   since moved past is closed without any request. Delivery, each step recorded so a retry never repeats it:
     1. the customer's HighLevel contact: the visit's or its customer's linked contact (or the one this customer job
        already used); a new one is upserted only outside a messaging dry run, as the GHL-TRACK-1 tag outbox does;
     2. ONE opportunity per customer job (the Hub project) in the EGC Pipeline, moved forward to Walkthrough
        Appointment or Job Scheduled (highlevel-pipeline.js): never backwards past a later stage (a Paid in Full deal
        stays where it is), never a closed one, never a guess between several open ones (that parks for a person),
        created only when the contact has no open opportunity in the pipeline;
     3. one internal contact note for the change: date, Denver time window, crew or estimator, address and the job
        breakdown the visit carries (no prices).
   A walkthrough's opportunity is assigned to its estimator's HighLevel user when the staff profile maps one
   (highlevel-users.js), else HIGHLEVEL_USER_ID. Nothing here adds a tag, writes an appointment or sends a message:
   booked-status tags stay with the tag outbox and the calendar stays an optional mirror (highlevel-calendars.js).
   Failures back off 1, 5, 15, 60 minutes and park after 8 attempts for a manager's Retry. */
import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields } from './firestore-job.js';
import { dispatchStorage } from './dispatch-storage.js';
import { canDispatch } from './dispatch-permissions.js';
import { scheduleInterval } from './dispatch-time.js';
import { addContactNote, ensureContact, ghl, ghlScheduleMirrorEnabled, highLevelConfig } from './highlevel-tags.js';
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

/** The mirror entry a schedule change commits with, as a list of writes ([] with the flag off or nothing to tell).
 * The writer passes its store (store.ghlScheduleMirror carries the flag), the visit before and after the change, its
 * request id and, for the note, the roster and dispatch resources it already holds. */
export async function scheduleMirrorWrites(store, { jobId, before = null, after, action, requestId, now, source = 'dispatch', roster = [], resources = [] } = {}) {
  if (store?.ghlScheduleMirror !== true) return [];
  const kind = scheduleMirrorEvent(before, after, action);
  if (!kind || !safeId(jobId) || typeof requestId !== 'string' || !requestId || typeof now !== 'string') return [];
  const job = { ...after, id: jobId }, visit = visitKind(job.type), active = kind !== 'cancelled' && kind !== 'no_show';
  const changeKey = scheduleMirrorChangeKey(source, requestId), id = await scheduleMirrorEntryId(jobId, changeKey);
  return [{ collection: GHL_SCHEDULE_MIRROR, id, patch: {
    id, jobId, changeKey, kind, visitType: visit, stage: active ? GHL_MIRROR_STAGES[visit] : null, projectKey: projectKeyOf(job),
    customerId: safeId(job.customerId) ? job.customerId : '', estimatorId: walkthroughEstimator(job), note: scheduleMirrorNote({ kind, job, roster, resources }),
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

const OPEN_LIMIT = 100;
/** Step 2: the customer job's one opportunity, moved forward to the entry's stage. Returns {outcome, opportunityId?, linkPatch?}. */
async function mirrorOpportunity(store, run, { entry, job, contactId, link, linkId, now }) {
  const { c, pipeline } = run, target = entry.stage === GHL_MIRROR_STAGES.walkthrough ? pipeline.walkthroughStageId : pipeline.jobScheduledStageId;
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
      if ((found.contactId || found.contact?.id) !== contactId || found.pipelineId !== pipeline.pipelineId) return { outcome: 'needs_link', review: true };
      opportunity = found;
    }
  }
  if (!opportunity) {
    const params = new URLSearchParams({ locationId: c.locationId, contactId, status: 'open', limit: String(OPEN_LIMIT), page: '1' });
    const found = await run.ghl(`/opportunities/search?${params}`);
    if (!Array.isArray(found?.opportunities)) throw fail('ghl_mirror_opportunity_search_unverified', 'HighLevel returned no opportunity list.', 502);
    if (found.opportunities.length >= OPEN_LIMIT || Number(found.meta?.total || 0) > found.opportunities.length) return { outcome: 'needs_link', review: true };
    const open = found.opportunities.filter(row => object(row) && (row.contactId || row.contact?.id) === contactId && row.pipelineId === pipeline.pipelineId);
    if (open.length > 1) return { outcome: 'needs_link', review: true };
    if (open.length === 1) opportunity = open[0];
    else {
      // Only one attempt creates a customer job's opportunity: the link record is claimed first (compare-and-set).
      // A claim another attempt holds waits its turn; an abandoned one is found again by the search above.
      if (link?.creatingEntryId && link.creatingEntryId !== entry.id && ms(link.creatingUntil) > Date.parse(now)) throw fail('ghl_mirror_opportunity_busy', 'Another schedule change is creating this customer job\'s opportunity.', 409);
      try { await store.commit([{ collection: GHL_SCHEDULE_MIRROR_LINKS, id: linkId, revision: link?.revision, patch: { id: linkId, projectKey: entry.projectKey, contactId, creatingEntryId: entry.id, creatingUntil: iso(Date.parse(now) + GHL_MIRROR_CLAIM_MINUTES * 60000), updatedAt: now } }]); }
      catch { throw fail('ghl_mirror_opportunity_busy', 'Another schedule change is creating this customer job\'s opportunity.', 409); }
      const amount = Number(job.total ?? job.priceQuoted);
      const created = await run.ghl('/opportunities/upsert', { method: 'POST', headers: { 'Idempotency-Key': `egc-schedule-mirror:${entry.projectKey}` }, body: JSON.stringify({
        pipelineId: pipeline.pipelineId, locationId: c.locationId, name, pipelineStageId: target, status: 'open', contactId,
        monetaryValue: entry.visitType === 'job' && Number.isFinite(amount) && amount > 0 ? amount : 0, assignedTo: assignee || c.userId || undefined,
      }) });
      const createdId = created?.opportunity?.id || created?.id || '';
      if (!createdId) throw fail('ghl_mirror_opportunity_unconfirmed', 'HighLevel returned no opportunity id.', 502);
      return { outcome: 'created', opportunityId: createdId, linkPatch: { opportunityId: createdId, creatingEntryId: '', creatingUntil: '' } };
    }
  }
  const id = opportunity.id, current = opportunity.pipelineStageId || '', linkPatch = { opportunityId: id };
  if (opportunity.status && opportunity.status !== 'open') return { outcome: 'closed', opportunityId: id, linkPatch };
  if (current === target) return { outcome: 'at_stage', opportunityId: id, linkPatch };
  if (rank(current) < 0) return { outcome: 'stage_unknown', opportunityId: id, linkPatch };
  if (rank(current) > rank(target)) return { outcome: 'later_stage', opportunityId: id, linkPatch };
  const value = Number(opportunity.monetaryValue);
  await run.ghl(opportunityPath(id), { method: 'PUT', body: JSON.stringify({ pipelineId: pipeline.pipelineId, name: opportunity.name || name, pipelineStageId: target, status: 'open',
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
    if (!job || !stillCurrent(claimed, job)) return settle(store, claimed, { status: 'done', doneAt: now, skipped: job ? 'superseded' : 'job_missing', lastError: '' }, 'skipped');
    const linkId = await scheduleMirrorLinkId(claimed.projectKey || `visit_${claimed.jobId}`), link = await store.read(GHL_SCHEDULE_MIRROR_LINKS, linkId);
    let contactId = typeof steps.contactId === 'string' && steps.contactId ? steps.contactId : job.highlevelContactId || (safeId(job.customerId) ? (await store.read('customers', job.customerId))?.highlevelContactId : '') || link?.contactId || '';
    if (!contactId) {
      // GHL-ALIGN: a messaging dry run (EGC_MESSAGING_DRY_RUN unless exactly "false") never creates a HighLevel contact. A visit the
      // Hub never mirrors (Dispatch's 'not_needed': no contact, no appointment) has nothing to tell, as with the tag outbox.
      if (run.env.EGC_MESSAGING_DRY_RUN !== 'false') {
        if (job.syncStatus === 'not_needed') return settle(store, claimed, { status: 'done', doneAt: now, skipped: 'contact_not_linked', steps, lastError: '' }, 'skipped');
        throw fail('ghl_mirror_contact_not_linked', 'The visit has no linked HighLevel contact yet.', 409);
      }
      contactId = await ensureContact(run.c, { name: job.customer || '', phone: job.phone || '', email: job.email || '', address: job.address || '' }, 'EGC Hub schedule');
      if (!contactId) throw fail('ghl_mirror_contact_unresolved', 'HighLevel returned no contact.', 502);
    }
    steps.contactId = contactId;
    if (claimed.stage && !steps.opportunity) {
      const result = await mirrorOpportunity(store, run, { entry: claimed, job, contactId, link, linkId, now });
      if (result.review) review = 'ghl_mirror_opportunity_needs_link';
      else {
        steps.opportunity = result.outcome;
        if (result.opportunityId) steps.opportunityId = result.opportunityId;
        if (result.from !== undefined) steps.opportunityFrom = result.from;
        if (result.linkPatch) {
          const latest = await store.read(GHL_SCHEDULE_MIRROR_LINKS, linkId);
          links.push({ collection: GHL_SCHEDULE_MIRROR_LINKS, id: linkId, revision: latest?.revision, patch: { id: linkId, projectKey: claimed.projectKey, contactId, ...result.linkPatch, updatedAt: now } });
        }
      }
    }
    if (!steps.note) {
      const note = object(claimed.note) ? claimed.note : {};
      steps.note = await addContactNote(run.c, contactId, { title: String(note.title || 'EGC schedule update').slice(0, 200), body: String(note.body || ''), idempotencyKey: claimed.id }) || now;
    }
    // A customer job with several open opportunities, or a link to someone else's, waits for a person: the note is written,
    // the stage is not guessed. A manager's Retry, once HighLevel is tidied, tries the opportunity step again.
    if (review) return settle(store, claimed, { status: 'parked', steps, lastError: review }, 'parked', links);
    const outcome = await settle(store, claimed, { status: 'done', doneAt: now, steps, lastError: '' }, 'done', links);
    // A lost link write (another attempt touched the record) never undoes the delivery: the next search finds the deal again.
    return outcome === 'busy' && links.length ? settle(store, claimed, { status: 'done', doneAt: now, steps, lastError: '' }, 'done') : outcome;
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
  const run = { c, env, pipeline: schedulePipeline(env), stages: null, users: new Map(), readProfile, ghl: (path, options) => ghl(c, path, options) };
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

/** The Integrations screen's view: parked entries (they need a manager) and pending ones the drain is overdue on (the
 * worker has stopped), counted by entry, plus the signed drain worker's last check-in (shared with the tag outbox).
 * Counts only, never a visit, contact or note. `now` is an ISO string. */
export async function scheduleMirrorStatus(store, now) {
  const at = Date.parse(now), [parked, pending, beat] = await Promise.all([store.parked(), store.due(), store.read(GHL_TAG_DRAIN_STATE, GHL_TAG_DRAIN_STATE_ID).catch(() => null)]);
  const rows = parked.rows.filter(row => row.status === 'parked');
  return { enabled: true, parked: rows.length, needsLink: rows.filter(row => row.lastError === 'ghl_mirror_opportunity_needs_link').length,
    overdue: pending.rows.filter(row => ghlMirrorOverdue(row, at)).length, pending: pending.rows.length, drain: ghlTagDrainView(beat, at),
    complete: parked.truncated !== true && pending.truncated !== true, asOf: now };
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
 * query). An unreadable or malformed answer is never an empty queue. The flag rides on the store for the writers. */
export function scheduleMirrorStorage(env, fetcher = firestoreFetch) {
  const dispatch = dispatchStorage(env, fetcher);
  async function byStatus(status) {
    const query = { structuredQuery: { from: [{ collectionId: GHL_SCHEDULE_MIRROR }], where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: status } } }, limit: GHL_MIRROR_SCAN_LIMIT + 1 } };
    let response, rows;
    try { response = await fetcher(env, `${BASE}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(query), signal: AbortSignal.timeout(15000) }); }
    catch { throw fail('ghl_mirror_storage_unavailable', 'The HighLevel schedule mirror could not be read.', 503); }
    if (!response.ok) throw fail('ghl_mirror_storage_unavailable', 'The HighLevel schedule mirror could not be read.', 503);
    try { rows = await response.json(); } catch { throw fail('ghl_mirror_storage_incomplete', 'The HighLevel schedule mirror returned an unreadable answer.', 503); }
    if (!Array.isArray(rows) || rows.some(row => !object(row))) throw fail('ghl_mirror_storage_incomplete', 'The HighLevel schedule mirror returned an unreadable answer.', 503);
    const documents = rows.filter(row => row.document).map(row => decodeRow(row.document)).filter(row => row.status === status);
    return { rows: documents.slice(0, GHL_MIRROR_SCAN_LIMIT), truncated: documents.length > GHL_MIRROR_SCAN_LIMIT };
  }
  return { ghlScheduleMirror: ghlScheduleMirrorEnabled(env), read: (collection, id) => dispatch.read(collection, id), commit: writes => dispatch.commit(writes), due: () => byStatus('pending'), parked: () => byStatus('parked') };
}
