import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields, encodeFirestoreFields } from './firestore-job.js';
import { employeeAccountsConfigured, listEmployeeApplications } from './employee-accounts.js';
import { listHubUserProfiles } from './hub-session.js';
import { arrivalSettings } from './dispatch-arrival.js';
import { legacyBlockMode } from './dispatch-legacy-blocks.js';
import { readCollection } from './employee-vault.js';
import { primaryStaffRole, sanitizeStaffRoles } from './staff-roles.js';
import { legacyPersonKeys, staffDirectoryEnabled, storedWeeklyAvailability } from './staff-directory.js';
import { storedSkills } from './staff-skills.js';
import { segmentsEnabled } from './dispatch-segments.js';
import { crewNotificationsEnabled } from './crew-notifications.js';
import { ghlScheduleMirrorEnabled, ghlTagOutboxEnabled } from './highlevel-tags.js';
import { commitConflict, commitFailure } from './firestore-errors.js';
import { dispatchReadMode, windowedJobs, pagedQuery, customerCoverage, aggregateCount } from './dispatch-window-reads.js';
import { QUEUE_JOB_FIELDS } from './dispatch-queue.js';

const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const failure = (code, message, status = 503) => Object.assign(new Error(message), { code, status });
const CUSTOMER_FIELDS = ['name','firstName','lastName','phone','email','address','highlevelContactId'];
// A crew record as the crew schedule reads it; priority, code and serviceDays are the crew registry v2 fields (D3).
const CREW_RESOURCE_FIELDS = ['recordType','name','memberIds','leadId','status','priority','code','serviceDays'];
const HANDOFF_LEDGER_FIELDS = ['kind','actorId','jobId','sourceWalkthroughId','createdAt'];
function decode(document,collection,id) {
  const prefix=`/documents/${collection}/`,name=document?.name;
  const path=typeof name==='string'&&name.includes(prefix)?name.slice(name.indexOf(prefix)+prefix.length):'';
  if (!path||path.includes('/')||id&&path!==id||typeof document.updateTime!=='string'||!document.updateTime||document.fields!==undefined&&(!document.fields||typeof document.fields!=='object'||Array.isArray(document.fields))) throw failure('dispatch_storage_incomplete','Dispatch received a record without a verifiable identity or revision. Refresh before changing work.');
  return {...decodeFirestoreFields(document.fields || {}),id:path,revision:document.updateTime};
}
/** The fields a dispatch jobs scan returns (a Firestore field mask; tests apply the same mask). */
export const JOB_FIELDS = Object.freeze(['type','recordType','date','time','endDate','endTime','customerId','customerAccountOwnerJobId','customerMemoryInheritedFrom','propertyId','customer','phone','address','title','serviceType','status','pipelineStatus','assignedCrew','assignedTo','crewLead','crewId','vehicleId','crewNeeded','requiredCrewSize','travelBufferMinutes','jobInstructions','operationalScope.text','scope','scopeOfWork','accessInstructions','customerInstructions','opsNotes','requiredEquipment','materials','syncStatus','highlevelAppointmentId','highlevelContactId','sourceWalkthroughId','sourceTemplateJobId','recurrence','recurrenceParentId','reminderDays','notify','shiftPickupEnabled','openShift','notes','durationMin','estimatedDurationMin','createdAt','updatedAt','completedAt','cancelledAt','startedAt','employee','employeeId','allDay','reason','startAt','endAt','fieldExecution.activity','fieldExecution.activityReason','fieldExecution.activityAt','fieldExecution.activityBy','fieldExecution.attention','fieldExecution.jobTime','fieldLastActionAt','fieldCompletionSync.status','fieldCompletionSync.message','fieldCompletionSync.attemptedAt','fieldCompletionSync.syncedAt','arrivalWindowStart','arrivalWindowEnd','arrivalWindow','assignmentSegments',
  // Server-side only (dispatch-duration.js). The quote lines themselves are
  // large and carry money, so no shared scan loads them: quoteLines() reads
  // them for the sold jobs a dispatch list projects.
  'estimate.status','durationOverride.minutes','durationOverride.reason','durationOverride.crewSize','durationOverride.source','logistics.crew_size',
  // Required skills are read by the dispatch rules (dispatch-rules.js).
  'requiredSkills',
  // GHL-TRACK-1: the visit's newest HighLevel tag outbox entry (ghl-tag-outbox.js), for the card's HighLevel chip.
  'ghlTagEntry',
  // FIX-DISPATCH-READY: reminder readiness from today's browser calendar sync and the Jobber import (dispatch-readiness.js).
  'scheduleSource','notifySetAt','automationTagSynced','automationReminderTag','automationReminderTaggedAt','syncLastAttemptAt','syncedAt',
  // WT-OUTCOME: where a walkthrough stands and what a no-show rebook prefills (walkthrough-state.js); never the rep's notes.
  'walkthroughOutcome.outcome','walkthroughOutcome.reasonCode','walkthroughOutcome.finishedAt','walkthroughOutcome.occurrence','walkthroughCompletedAt','convertedJobId','scheduleOccurrence','noShowReasonCode','noShowAt',
  // FIX-DISPATCH-QUEUE: To schedule's review flag, sold and approved dates and Jobber visits (dispatch-queue.js); no amounts.
  ...QUEUE_JOB_FIELDS,
  // D2D-BOARD: a door-to-door job's mark on the schedule (projectDispatchJob): its source and d2d.kind only, never the rep or house.
  'source','d2d.kind']);

/** Owner decision F19: the owner and managers are office staff and join assignment
 * lists only when they take field work, recorded as stored staffRoles that also
 * include crew, crew_lead or team_lead (staffRoles in the Hub user configuration for
 * configured users, or the Team screen's roles for employee accounts). */
const FIELD_ROLES = Object.freeze(['team_lead', 'crew_lead', 'crew']);
export function officeOnly(role, roles) {
  return ['owner', 'manager'].includes(role) && !(Array.isArray(roles) && roles.some(value => FIELD_ROLES.includes(value)));
}

// Roles come from stored staff roles (configuration or the encrypted account), else the
// configured role or namedStaffRole(). With EGC_STAFF_DIRECTORY_ENABLED the rows also
// carry staffRoles, skills and weekly availability from the encrypted profiles, and an
// office-only owner or manager (officeOnly) carries fieldWork:false; other rows omit it.
export async function dispatchRoster(env) {
  const roles = [], role = (stored, fallback) => stored ? primaryStaffRole(stored) : fallback;
  const profiles = listHubUserProfiles(env).map(p => {
    const stored = sanitizeStaffRoles(p.staffRoles, p);
    roles.push(stored || [p.role]);
    return { id: p.user.trim().toLowerCase(), name: p.displayName, role: role(stored, p.role) };
  });
  if (employeeAccountsConfigured(env)) {
    const approved = (await listEmployeeApplications(env)).filter(p => p.status === 'approved');
    for (const p of approved) {
      const username = String(p.username || p.user || ''), stored = sanitizeStaffRoles(p.staffRoles, { user: username, businessAccess: false });
      roles.push(stored || [p.role === 'sales' ? 'sales' : 'crew']);
      profiles.push({ id: username.trim().toLowerCase(), name: p.displayName, role: role(stored, p.role === 'sales' ? 'sales' : 'crew') });
    }
  }
  const seen = new Set();
  for (const profile of profiles) {
    if (!profile.id || seen.has(profile.id)) throw failure('dispatch_roster_ambiguous', 'Employee identities need review before dispatch can safely assign work.');
    seen.add(profile.id);
  }
  if (staffDirectoryEnabled(env)) {
    let stored;
    try { stored = await readCollection(env, 'profiles'); }
    catch { throw failure('dispatch_storage_unavailable', 'Staff skills and availability could not be verified. Retry before scheduling.'); }
    profiles.forEach((profile, index) => {
      const ids = [profile.id, ...legacyPersonKeys(profile.id)], saved = ids.map(id => stored.find(row => row?.id === id && String(row.username || '').trim().toLowerCase() === profile.id)).find(Boolean) || {};
      Object.assign(profile, { staffRoles: roles[index], skills: storedSkills(saved.skills).map(({ id, level }) => ({ id, level })), weeklyAvailability: storedWeeklyAvailability(saved.weeklyAvailability),
        ...(officeOnly(profile.role, roles[index]) ? { fieldWork: false } : {}) });
    });
  }
  return profiles.sort((a, b) => a.name.localeCompare(b.name));
}

/* READ-BUDGET: one small openings snapshot cache per Firestore fetcher: one per isolate in production (firestoreFetch),
   one per fake in tests. It holds no answer: dispatch-openings.js reuses an entry only while the dispatch guard and
   every day lock it covers are unchanged, within a few minutes, and reads the roster and rules again each time. */
const openingsCaches = new WeakMap();
// spanningJobs: when Firestore last refused it for want of its index, per fetcher, so a missing index costs one refused
// query every INDEX_RETRY_MS rather than one on every schedule read.
const spanningRefused = new WeakMap(), INDEX_RETRY_MS = 10 * 60000;
// Firestore refuses a query no index can serve with HTTP 400 FAILED_PRECONDITION, as {error} or as [{error}].
async function indexRefusal(response) {
  if (response.status !== 400) return false;
  const body = await response.json().catch(() => null), error = Array.isArray(body) ? body[0]?.error : body?.error;
  return error?.status === 'FAILED_PRECONDITION';
}
function openingsCacheFor(fetcher) {
  if (typeof fetcher !== 'function') return null;
  if (!openingsCaches.has(fetcher)) openingsCaches.set(fetcher, new Map());
  return openingsCaches.get(fetcher);
}

export function dispatchStorage(env, fetcher = firestoreFetch) {
  async function send(url, options = {}) {
    try { return await fetcher(env, url, { ...options, signal: AbortSignal.timeout(20000) }); }
    catch { throw failure('dispatch_storage_unavailable', 'Dispatch storage is unavailable. Keep your changes and retry.'); }
  }
  async function scan(collection, fields, limit = 10000) {
    const rows = [], tokens = new Set(), ids = new Set();
    let token = '';
    do {
      const url = new URL(`${BASE}/${collection}`);
      url.searchParams.set('pageSize', '500');
      if (token) url.searchParams.set('pageToken', token);
      for (const field of fields || []) url.searchParams.append('mask.fieldPaths', field);
      const response = await send(url);
      if (!response.ok) throw failure('dispatch_storage_unavailable', 'The complete dispatch records could not be loaded. Retry before scheduling.');
      const page = await response.json();
      if (!page||typeof page!=='object'||Array.isArray(page)||page.nextPageToken!==undefined&&typeof page.nextPageToken!=='string') throw failure('dispatch_storage_incomplete','Dispatch pagination returned incomplete metadata. Retry before scheduling.');
      if (page.documents !== undefined && !Array.isArray(page.documents)) throw failure('dispatch_storage_incomplete', 'Dispatch returned incomplete records. Retry before scheduling.');
      for (const document of page.documents || []) {
        const row = decode(document,collection);
        if (!row.id || ids.has(row.id) || rows.length >= limit) throw failure('dispatch_storage_incomplete', 'Dispatch could not verify the complete schedule. Narrowing the displayed dates will not bypass conflict checks.');
        rows.push(row); ids.add(row.id);
      }
      token = page.nextPageToken || '';
      if (token && tokens.has(token)) throw failure('dispatch_storage_incomplete', 'Dispatch pagination did not finish. Retry before scheduling.');
      tokens.add(token);
    } while (token);
    return rows;
  }
  async function post(action, body) {
    const response = await send(`${BASE}:${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw failure('dispatch_storage_unavailable', 'The dispatch records could not be queried. Retry before scheduling.');
    return response.json().catch(() => null);
  }
  const query = (collection, fields, limit) => spec => pagedQuery({ post: body => post('runQuery', body), decode: document => decode(document, collection), collection, spec, fields, limit });
  // CREW-SCHEDULE: every jobs row whose start date is in [startDate,endDate], one bounded range on the single field
  // `date` (no composite index), masked to `fields` and fully paginated. A malformed page, a row outside the range,
  // a repeated row or more than `limit` rows fails closed; a partial schedule is never returned.
  async function datedJobs(startDate, endDate, fields, limit = 5000) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endDate < startDate) throw failure('dispatch_range_invalid', 'Choose a valid date range.', 400);
    if (!Array.isArray(fields) || !fields.length || !fields.includes('date')) throw failure('dispatch_storage_mask_required', 'A dated jobs query must name the fields it reads, including date.');
    const field = { fieldPath: 'date' }, bound = (op, stringValue) => ({ fieldFilter: { field, op, value: { stringValue } } });
    const rows = [], ids = new Set();
    let after = null;
    for (let page = 0; page <= Math.ceil(limit / 500); page++) {
      const results = await post('runQuery', { structuredQuery: { from: [{ collectionId: 'jobs' }], select: { fields: fields.map(fieldPath => ({ fieldPath })) },
        where: { compositeFilter: { op: 'AND', filters: [bound('GREATER_THAN_OR_EQUAL', startDate), bound('LESS_THAN_OR_EQUAL', endDate)] } },
        orderBy: [{ field, direction: 'ASCENDING' }, { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }], limit: 500,
        ...(after ? { startAt: { values: [{ stringValue: after.date }, { referenceValue: after.name }], before: false } } : {}) } });
      if (!Array.isArray(results) || results.some(result => !result || typeof result !== 'object' || Array.isArray(result)) || !results.some(result => result.document !== undefined || typeof result.readTime === 'string' && result.readTime)) throw failure('dispatch_storage_incomplete', 'The schedule query returned an incomplete answer. Retry.');
      const documents = results.filter(result => result.document !== undefined).map(result => result.document);
      for (const document of documents) {
        const row = decode(document, 'jobs');
        if (ids.has(row.id) || rows.length >= limit || typeof row.date !== 'string' || row.date < startDate || row.date > endDate) throw failure('dispatch_storage_incomplete', 'The schedule query could not be verified. Retry.');
        ids.add(row.id); rows.push(row);
      }
      if (documents.length < 500) return rows;
      after = { name: documents.at(-1).name, date: rows.at(-1).date };
    }
    throw failure('dispatch_storage_incomplete', 'The schedule query did not finish. Retry.');
  }
  // READ-BUDGET (crew schedule): the jobs rows starting before startDate and ending on or after it (multi-day work running
  // into a window that starts then), one query with ranges on endDate and date. Firestore serves it only from the
  // composite index jobs(endDate ASC, date ASC) in firestore.indexes.json; until that is deployed it refuses the query
  // (FAILED_PRECONDITION) and this throws dispatch_index_required, so the caller reads the longer date range instead.
  // Masked, fully paginated and verified like datedJobs: anything else fails closed. `strict` (the windowed reads' SPANS
  // net, dispatch-window-reads.js) filters date < startDate instead, so a malformed date string sorting between the day
  // before and startDate is read too.
  async function spanningJobs(startDate, fields, limit = 5000, strict = false) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw failure('dispatch_range_invalid', 'Choose a valid date range.', 400);
    if (!Array.isArray(fields) || !fields.includes('date') || !fields.includes('endDate')) throw failure('dispatch_storage_mask_required', 'A multi-day jobs query must name the fields it reads, including date and endDate.');
    const waiting = () => failure('dispatch_index_required', 'The multi-day schedule query is waiting for its index.');
    if (typeof fetcher === 'function' && Date.now() - (spanningRefused.get(fetcher) ?? -Infinity) < INDEX_RETRY_MS) throw waiting();
    const dayBefore = new Date(Date.parse(`${startDate}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const filter = (fieldPath, op, stringValue) => ({ fieldFilter: { field: { fieldPath }, op, value: { stringValue } } });
    const rows = [], ids = new Set();
    let after = null;
    for (let page = 0; page <= Math.ceil(limit / 500); page++) {
      const response = await send(`${BASE}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'jobs' }], select: { fields: fields.map(fieldPath => ({ fieldPath })) },
        where: { compositeFilter: { op: 'AND', filters: [filter('endDate', 'GREATER_THAN_OR_EQUAL', startDate), strict ? filter('date', 'LESS_THAN', startDate) : filter('date', 'LESS_THAN_OR_EQUAL', dayBefore)] } },
        orderBy: ['endDate', 'date', '__name__'].map(fieldPath => ({ field: { fieldPath }, direction: 'ASCENDING' })), limit: 500,
        ...(after ? { startAt: { values: [{ stringValue: after.endDate }, { stringValue: after.date }, { referenceValue: after.name }], before: false } } : {}) } }) });
      if (!response.ok) {
        if (!await indexRefusal(response)) throw failure('dispatch_storage_unavailable', 'The dispatch records could not be queried. Retry before scheduling.');
        if (typeof fetcher === 'function') spanningRefused.set(fetcher, Date.now());
        throw waiting();
      }
      const results = await response.json().catch(() => null);
      if (!Array.isArray(results) || results.some(result => !result || typeof result !== 'object' || Array.isArray(result)) || !results.some(result => result.document !== undefined || typeof result.readTime === 'string' && result.readTime)) throw failure('dispatch_storage_incomplete', 'The schedule query returned an incomplete answer. Retry.');
      const documents = results.filter(result => result.document !== undefined).map(result => result.document);
      for (const document of documents) {
        const row = decode(document, 'jobs');
        if (ids.has(row.id) || rows.length >= limit || typeof row.endDate !== 'string' || row.endDate < startDate || typeof row.date !== 'string' || (strict ? row.date >= startDate : row.date > dayBefore)) throw failure('dispatch_storage_incomplete', 'The schedule query could not be verified. Retry.');
        ids.add(row.id); rows.push(row);
      }
      if (documents.length < 500) return rows;
      after = { name: documents.at(-1).name, endDate: rows.at(-1).endDate, date: rows.at(-1).date };
    }
    throw failure('dispatch_storage_incomplete', 'The schedule query did not finish. Retry.');
  }
  // The windowed reads' queries. SPANS (rows starting before the floor and ending on or after it) is one spanningJobs
  // query on the jobs(endDate, date) index; until that index is deployed, the endDate pass it replaces, as before.
  const jobsQuery = query('jobs', JOB_FIELDS);
  const windowQuery = spec => spec.op !== 'SPANS' ? jobsQuery(spec) : spanningJobs(spec.value, JOB_FIELDS, 10000, true)
    .catch(error => { if (error?.code !== 'dispatch_index_required') throw error; return jobsQuery({ field: 'endDate', op: 'GREATER_THAN_OR_EQUAL', value: spec.value }); });
  return {
    roster: () => dispatchRoster(env),
    jobs: () => scan('jobs', JOB_FIELDS),
    // EGC_DISPATCH_WINDOWED_READS: 'full' (default), 'shadow' or 'windowed'.
    // Windowed and indexed reads are complete and fail closed like the scans.
    windowedReads: dispatchReadMode(env),
    // `bound` (optional): the bounded read, rows starting no later than it, or every start with `everyStart` (a dated
    // save), plus the SPANS net (dispatch-window-reads.js READ-BUDGET).
    jobsNear: (startDate, endDate, bound = null, everyStart = false) => windowedJobs(windowQuery, startDate, endDate, bound, everyStart),
    // READ-BUDGET: the openings snapshot cache a caller may opt into (dispatch-openings.js options.cache).
    openingsCache: openingsCacheFor(fetcher),
    // Every jobs row whose field equals value, whatever its dates (saveJobReads).
    jobsWhere: (field, value) => query('jobs', JOB_FIELDS)({ field, op: 'EQUAL', value }),
    // ESTIMATOR-COMMISSION (D6b, estimator-commission.js): the signed walkthrough handoff receipts, masked to who signed which
    // job when (never the signature, plan or amount): one signer's ({field:'actorId', op:'EQUAL'}) or those created since a
    // date ({field:'createdAt', op:'GREATER_THAN_OR_EQUAL'}). Complete and failing closed like every query here.
    // `fields` (optional) widens the mask for a caller that needs more of the receipt (open-quotes.js: the prior estimate's
    // status and acceptance time, never the signature or plan).
    handoffLedger: (spec, fields = HANDOFF_LEDGER_FIELDS) => query('walkthroughHandoffs', fields, 5000)(spec),
    // OPEN-QUOTES (open-quotes.js): the estimator quotes sent on or after an ISO time, one range on the nested single
    // field quoteDraft.sentAt (Firestore's automatic single-field index; no composite index), masked to `fields`.
    sentQuoteJobs: (since, fields, limit = 5000) => query('jobs', fields, limit)({ field: 'quoteDraft.sentAt', op: 'GREATER_THAN_OR_EQUAL', value: since }),
    customersByKey: key => query('customers', [...CUSTOMER_FIELDS, 'searchKeys'], 20000)({ field: 'searchKeys', op: 'ARRAY_CONTAINS', value: key }),
    // CREW-SCHEDULE (functions/api/crew-schedule.js): the crew records alone, and the work dated in a bounded window.
    crewResources: () => query('dispatchResources', CREW_RESOURCE_FIELDS, 2000)({ field: 'recordType', op: 'EQUAL', value: 'crew' }),
    datedJobs, spanningJobs,
    customerKeyCoverage: () => customerCoverage(async body => aggregateCount(await post('runAggregationQuery', body))),
    async customerRecords(fields) {
      if (!Array.isArray(fields) || !fields.length || fields.some(field => typeof field !== 'string' || !field)) throw failure('dispatch_storage_mask_required', 'A customers scan must name the fields it reads.');
      return scan('customers', fields, 20000);
    },
    // Complete paginated scan narrowed to the caller's DTO inputs. A mask is
    // mandatory: raw job bodies carry signature images and payment evidence.
    async jobRecords(fields) {
      if (!Array.isArray(fields) || !fields.length || fields.some(field => typeof field !== 'string' || !field)) throw failure('dispatch_storage_mask_required', 'A jobs scan must name the fields it reads.');
      return scan('jobs', fields);
    },
    legacyBlockMode: legacyBlockMode(env),
    // EGC_DISPATCH_SEGMENTS: segment writes; reads always honour saved segments.
    segmentsEnabled: segmentsEnabled(env),
    // EGC_CREW_NOTIFICATIONS_ENABLED: dispatch saves queue crew notices in the same commit.
    crewNotificationsEnabled: crewNotificationsEnabled(env),
    // EGC_GHL_TAG_OUTBOX: schedule changes queue their HighLevel tags in the same commit (ghl-tag-outbox.js).
    ghlTagOutbox: ghlTagOutboxEnabled(env),
    // EGC_GHL_SCHEDULE_MIRROR (D9b): schedule changes queue their HighLevel schedule mirror in the same commit (ghl-schedule-mirror.js).
    ghlScheduleMirror: ghlScheduleMirrorEnabled(env),
    // EGC_DISPATCH_NOTIFY_IMPORTED_ON: an imported Jobber job's first booking turns reminders on (dispatch-readiness.js notifyPatch).
    notifyImportedOn: env?.EGC_DISPATCH_NOTIFY_IMPORTED_ON === 'true',
    async legacyBlockedDays(dates) {
      const found = await Promise.all(dates.map(async date => {
        const response = await send(`${BASE}/blocked_days/${encodeURIComponent(date)}?mask.fieldPaths=blockedAt`);
        if (response.status === 404) return null;
        if (!response.ok) throw failure('dispatch_storage_unavailable', 'Blocked calendar days could not be verified. Retry before scheduling.');
        return decode(await response.json(), 'blocked_days', date).id;
      }));
      return found.filter(Boolean);
    },
    resources: () => scan('dispatchResources', null, 2000),
    customers: () => scan('customers', CUSTOMER_FIELDS, 20000),
    settings: async () => arrivalSettings(env),
    recurringPlans: () => scan('recurringPlans', null, 2000),
    // JOB-COST-PRIVACY: the owner-only job labor records (functions/_lib/job-labor-private.js), one per job at most.
    jobLaborCosts: () => scan('jobLaborCosts', ['jobId', 'laborCents', 'recordedAt', 'recordedBy', 'requestId'], 20000),
    projects: () => scan('projects', null, 20000),
    async read(collection, id) {
      const response = await send(`${BASE}/${collection}/${encodeURIComponent(id)}`);
      if (response.status === 404) return null;
      if (!response.ok) throw failure('dispatch_storage_unavailable', 'The dispatch record could not be loaded. Retry.');
      return decode(await response.json(),collection,id);
    },
    // `fields` masks the documents: a caller that only needs to know which exist reads no bodies.
    async readMany(collection, ids, fields) {
      if (!ids.length) return [];
      const response = await send(`${BASE}:batchGet`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documents: ids.map(id => `${ROOT}/${collection}/${id}`), ...(fields?.length ? { mask: { fieldPaths: fields } } : {}) }) });
      if (!response.ok) throw failure('dispatch_storage_unavailable', 'The dispatch records could not be loaded. Retry.');
      const rows = await response.json();
      if (!Array.isArray(rows)) throw failure('dispatch_storage_incomplete', 'Dispatch returned incomplete records. Retry.');
      return rows.filter(row => row?.found).map(row => decode(row.found,collection));
    },
    // Map id -> {id,revision,estimate:{lineItems}} for the jobs found.
    async quoteLines(ids) {
      const found = new Map(), chunks = [];
      for (let index = 0; index < ids.length; index += 100) chunks.push(ids.slice(index, index + 100));
      await Promise.all(chunks.map(async chunk => {
        const response = await send(`${BASE}:batchGet`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documents: chunk.map(id => `${ROOT}/jobs/${id}`), mask: { fieldPaths: ['estimate.lineItems'] } }) });
        if (!response.ok) throw failure('dispatch_storage_unavailable', 'The quote lines could not be loaded. Retry.');
        const rows = await response.json();
        if (!Array.isArray(rows)) throw failure('dispatch_storage_incomplete', 'Dispatch returned incomplete quote lines. Retry.');
        for (const row of rows) if (row?.found) { const job = decode(row.found, 'jobs'); found.set(job.id, job); }
      }));
      return found;
    },
    async commit(writes) {
      let response,transaction;
      const checks=writes.filter(write=>write.verify),mutations=writes.filter(write=>!write.verify);
      const json=body=>({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const rollback=async()=>{if(transaction)await send(`${BASE}:rollback`,json({transaction})).catch(()=>null);};
      if(checks.length) {
        // Public REST Write has no documented read-only verify operation. A
        // transaction protects lineage reads without changing account documents.
        const started=await send(`${BASE}:beginTransaction`,json({options:{readWrite:{}}}));
        if(!started.ok)throw failure('dispatch_storage_unavailable','Customer account verification could not begin. Retry before creating this visit.');
        transaction=(await started.json()).transaction;
        if(typeof transaction!=='string'||!transaction)throw failure('dispatch_storage_incomplete','Customer account verification returned an incomplete transaction.');
        try {
          const result=await send(`${BASE}:batchGet`,json({documents:checks.map(write=>`${ROOT}/${write.collection}/${write.id}`),mask:{fieldPaths:['customerId']},transaction}));
          if(!result.ok)throw failure([409,412].includes(result.status)?'dispatch_revision_conflict':'dispatch_storage_unavailable','Customer account records changed or could not be verified. Refresh before saving.',[409,412].includes(result.status)?409:503);
          const rows=await result.json();
          if(!Array.isArray(rows)||rows.length!==checks.length)throw failure('dispatch_storage_incomplete','The complete set of customer account revisions could not be verified.');
          const found=new Map();
          for(const row of rows) {
            if(row.missing)throw failure('dispatch_revision_conflict','A source customer account was removed. Refresh before creating this visit.',409);
            if(!row.found?.name||found.has(row.found.name))throw failure('dispatch_storage_incomplete','Customer account verification returned duplicate or incomplete records.');
            found.set(row.found.name,row.found);
          }
          for(const check of checks) {
            const suffix=`/documents/${check.collection}/${check.id}`;
            const document=[...found.values()].find(row=>row.name.endsWith(suffix));
            if(!document||document.updateTime!==check.revision)throw failure('dispatch_revision_conflict','Customer account ownership changed while the visit was being created. Refresh and review the source job.',409);
          }
        } catch(error) {await rollback();throw error;}
      }
      try {
        response = await send(`${BASE}:commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          ...(transaction?{transaction}:{}),
          writes: mutations.map(write => ({
            update: { name: `${ROOT}/${write.collection}/${write.id}`, fields: encodeFirestoreFields(write.patch) },
            updateMask: { fieldPaths: Object.keys(write.patch) },
            currentDocument: write.revision ? { updateTime: write.revision } : { exists: false },
          })),
        }) });
      } catch { await rollback();throw failure('dispatch_outcome_unknown', 'The save response was lost. Retry the same request to safely verify whether it saved.'); }
      if (!response.ok) {
        const failed = await commitFailure(response);
        await rollback();
        // A stale updateTime is 400 FAILED_PRECONDITION on real Firestore; it never applied.
        if (commitConflict(failed)) throw failure('dispatch_revision_conflict', 'The schedule changed while you were editing. Refresh and review the latest information.', 409);
        throw failure('dispatch_outcome_unknown', 'The save could not be verified. Retry the same request to safely check its outcome.');
      }
      return response.json();
    },
  };
}
