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
import { commitConflict, commitFailure } from './firestore-errors.js';
import { dispatchReadMode, windowedJobs, pagedQuery, customerCoverage, aggregateCount } from './dispatch-window-reads.js';

const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const failure = (code, message, status = 503) => Object.assign(new Error(message), { code, status });
const CUSTOMER_FIELDS = ['name','firstName','lastName','phone','email','address','highlevelContactId'];
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
  'requiredSkills']);

/** Owner decision F19: the owner and managers are office staff and join assignment
 * lists only when they take field work, recorded as stored staffRoles that also
 * include crew or crew_lead (staffRoles in the Hub user configuration for configured
 * users, or the Team screen's roles for employee accounts). */
export function officeOnly(role, roles) {
  return ['owner', 'manager'].includes(role) && !(Array.isArray(roles) && roles.some(value => value === 'crew' || value === 'crew_lead'));
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
  return {
    roster: () => dispatchRoster(env),
    jobs: () => scan('jobs', JOB_FIELDS),
    // EGC_DISPATCH_WINDOWED_READS: 'full' (default), 'shadow' or 'windowed'.
    // Windowed and indexed reads are complete and fail closed like the scans.
    windowedReads: dispatchReadMode(env),
    jobsNear: (startDate, endDate) => windowedJobs(query('jobs', JOB_FIELDS), startDate, endDate),
    // Every jobs row whose field equals value, whatever its dates (saveJobReads).
    jobsWhere: (field, value) => query('jobs', JOB_FIELDS)({ field, op: 'EQUAL', value }),
    customersByKey: key => query('customers', [...CUSTOMER_FIELDS, 'searchKeys'], 20000)({ field: 'searchKeys', op: 'ARRAY_CONTAINS', value: key }),
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
