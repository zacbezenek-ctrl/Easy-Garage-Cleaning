import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields } from './firestore-job.js';
import { pagedQuery } from './dispatch-window-reads.js';
import { denverToday } from './dispatch-time.js';
import { assignmentKey, createJobAssignmentAccess } from './job-assignment.js';
import { requireQuoteAuthor } from './quote-permissions.js';
import { can } from './staff-roles.js';
import { walkthroughCard } from './walkthrough-state.js';
import { selfWalkthroughVisitId } from './knock-self-walkthrough.js';

/** WP5 read fix: the walkthrough gameplan (crew/gameplan.html) reads its walkthroughs from the server, not the
 * Firestore SDK, so a Sales estimator (no business_access claim, firestore.rules) can open them.
 * GET /api/walkthrough-handoff?view=walkthroughs[&walkthroughId=<id>] (a quote author, as for the signed handoff):
 *   {ok, authority, date, walkthroughs:[row], requested: row|null}
 * walkthroughs are today's (Denver) open walkthroughs the viewer may run, by start time: every one for a dispatcher
 * or a booker (schedule.book, as /api/walkthrough-visit lets them read any visit), else only those assigned to the
 * viewer or that the viewer started. requested is that one walkthrough (any date) under the same rule; a missing,
 * cancelled or completed one is 404 handoff_walkthrough_unavailable and another rep's is 403
 * handoff_walkthrough_forbidden. A row is the gameplan's prefill: the crew card (walkthrough-state.js
 * walkthroughCard: time, customer, phone, address and where the visit stands) plus email, the HighLevel ids,
 * the lead source and the customer's request. Never notes, estimates, signatures, crew or other jobs.
 * One masked equality query on today's jobs (the reads the SDK list made) and one document read for requested.
 * REP-WALKTHROUGH: a Knock rep's session for their own self-run walkthrough (knock-self-walkthrough.js) lists that one
 * visit only and answers selfRun: true, which opens the gameplan for it. */
export const GAMEPLAN_WALKTHROUGH_FIELDS = Object.freeze(['type', 'recordType', 'date', 'time', 'endDate', 'endTime', 'status', 'pipelineStatus', 'customer', 'name', 'title', 'phone', 'email', 'address',
  'arrivalWindow', 'arrivalWindowStart', 'arrivalWindowEnd', 'highlevelContactId', 'contactId', 'highlevelOpportunityId', 'highlevelAppointmentId', 'source', 'customerInstructions',
  'assignedCrew', 'assignedTo', 'crewLead', 'walkthroughVisit.startedBy', 'walkthroughOutcome.outcome', 'walkthroughOutcome.reasonCode', 'walkthroughOutcome.finishedAt', 'walkthroughOutcome.occurrence',
  'walkthroughCompletedAt', 'convertedJobId', 'scheduleOccurrence']);
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const fail = (code, message, status = 400) => Object.assign(new Error(message), { code: `handoff_${code}`, status });
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) && !/^(secure_|_egc_)/.test(value);
const text = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const providerId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value) ? value : '';
// The gameplan's own rule for an appointment it can open (gameplan.html before this fix).
const closed = row => ['cancelled', 'canceled', 'completed'].includes(String(row.pipelineStatus || row.status || '').toLowerCase());

export function gameplanWalkthroughRow(visit) {
  const card = walkthroughCard(visit);
  return { ...card, pipelineStatus: text(visit.pipelineStatus || visit.status, 40), customer: card.customer || text(visit.name, 200) || text(visit.title, 200), email: text(visit.email, 254),
    highlevelContactId: providerId(visit.highlevelContactId) || providerId(visit.contactId), highlevelOpportunityId: providerId(visit.highlevelOpportunityId), highlevelAppointmentId: providerId(visit.highlevelAppointmentId),
    source: text(visit.source, 120), customerInstructions: text(visit.customerInstructions, 8000) };
}

/** Today's walkthroughs (masked) and one read by id, over the service account. */
export function gameplanWalkthroughStorage(env, fetcher = firestoreFetch) {
  async function send(url, options = {}) {
    try { return await fetcher(env, url, { ...options, signal: AbortSignal.timeout(20000) }); }
    catch { throw fail('storage_unavailable', 'The walkthrough schedule could not be loaded. Retry.', 503); }
  }
  const decode = (document, id) => {
    const prefix = '/documents/jobs/', name = document?.name, path = typeof name === 'string' && name.includes(prefix) ? name.slice(name.indexOf(prefix) + prefix.length) : '';
    if (!path || path.includes('/') || id && path !== id || typeof document.updateTime !== 'string') throw fail('storage_incomplete', 'The walkthrough schedule could not be verified. Retry.', 503);
    return { ...decodeFirestoreFields(document.fields || {}), id: path, revision: document.updateTime };
  };
  return {
    async walkthroughsOn(date) {
      const post = async body => { const response = await send(`${BASE}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!response.ok) throw fail('storage_unavailable', 'The walkthrough schedule could not be loaded. Retry.', 503); return response.json().catch(() => null); };
      return pagedQuery({ post, decode: document => decode(document), collection: 'jobs', spec: { field: 'date', op: 'EQUAL', value: date }, fields: [...GAMEPLAN_WALKTHROUGH_FIELDS], limit: 2000 });
    },
    async read(id) {
      const url = new URL(`${BASE}/jobs/${encodeURIComponent(id)}`);
      for (const field of GAMEPLAN_WALKTHROUGH_FIELDS) url.searchParams.append('mask.fieldPaths', field);
      const response = await send(url);
      if (response.status === 404) return null;
      if (!response.ok) throw fail('storage_unavailable', 'The walkthrough could not be loaded. Retry.', 503);
      return decode(await response.json(), id);
    },
  };
}

export async function gameplanWalkthroughs(store, actor, query = {}, { env = {}, now = new Date() } = {}) {
  const access = requireQuoteAuthor(actor, env);
  if (!query || Object.keys(query).some(key => !['view', 'walkthroughId'].includes(key)) || query.view !== 'walkthroughs' || query.walkthroughId !== undefined && !safeId(query.walkthroughId)) throw fail('invalid_request', 'The walkthrough lookup is invalid.', 400);
  const everyone = access.dispatcher || can(actor, 'schedule.book', env), assignment = createJobAssignmentAccess(env, actor), viewer = assignmentKey(actor.user);
  const visible = async visit => everyone || Boolean(viewer) && assignmentKey(visit.walkthroughVisit?.startedBy) === viewer || await assignment.assigned(visit);
  const walkthrough = visit => visit && visit.type === 'walkthrough' && !visit.recordType && safeId(visit.id);
  let requested = null;
  if (query.walkthroughId) {
    const visit = await store.read(query.walkthroughId);
    if (!walkthrough(visit) || closed(visit)) throw fail('walkthrough_unavailable', 'This walkthrough is missing, cancelled, or already completed.', 404);
    if (!await visible(visit)) throw fail('walkthrough_forbidden', 'This walkthrough is not assigned to you. Ask the office to assign it before you start.', 403);
    requested = gameplanWalkthroughRow(visit);
  }
  const date = denverToday(now), rows = [];
  for (const visit of await store.walkthroughsOn(date)) if (walkthrough(visit) && !closed(visit) && await visible(visit)) rows.push(gameplanWalkthroughRow(visit));
  rows.sort((a, b) => String(a.time).localeCompare(String(b.time)) || a.id.localeCompare(b.id));
  const own = selfWalkthroughVisitId(actor);
  if (own) return { ok: true, authority: 'employee_hub', date, walkthroughs: rows.filter(row => row.id === own), requested, selfRun: true };
  return { ok: true, authority: 'employee_hub', date, walkthroughs: rows, requested };
}
