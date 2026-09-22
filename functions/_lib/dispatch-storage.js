import { firestoreFetch } from './firebase-service-account.js';
import { decodeFirestoreFields, encodeFirestoreFields } from './firestore-job.js';
import { employeeAccountsConfigured, listEmployeeApplications } from './employee-accounts.js';
import { listHubUserProfiles } from './hub-session.js';

const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const failure = (code, message, status = 503) => Object.assign(new Error(message), { code, status });
function decode(document,collection,id) {
  const prefix=`/documents/${collection}/`,name=document?.name;
  const path=typeof name==='string'&&name.includes(prefix)?name.slice(name.indexOf(prefix)+prefix.length):'';
  if (!path||path.includes('/')||id&&path!==id||typeof document.updateTime!=='string'||!document.updateTime||document.fields!==undefined&&(!document.fields||typeof document.fields!=='object'||Array.isArray(document.fields))) throw failure('dispatch_storage_incomplete','Dispatch received a record without a verifiable identity or revision. Refresh before changing work.');
  return {...decodeFirestoreFields(document.fields || {}),id:path,revision:document.updateTime};
}
const JOB_FIELDS = ['type','recordType','date','time','endDate','endTime','customerId','customerAccountOwnerJobId','customerMemoryInheritedFrom','propertyId','customer','phone','address','title','serviceType','status','pipelineStatus','assignedCrew','assignedTo','crewLead','crewId','vehicleId','crewNeeded','requiredCrewSize','travelBufferMinutes','jobInstructions','operationalScope.text','scope','scopeOfWork','accessInstructions','customerInstructions','opsNotes','requiredEquipment','materials','syncStatus','highlevelAppointmentId','highlevelContactId','sourceWalkthroughId','sourceTemplateJobId','recurrence','recurrenceParentId','reminderDays','notify','shiftPickupEnabled','openShift','notes','durationMin','estimatedDurationMin','createdAt','updatedAt','completedAt','cancelledAt','startedAt','employee','employeeId','allDay','reason','startAt','endAt','fieldExecution.activity','fieldExecution.activityReason','fieldExecution.activityAt','fieldExecution.activityBy','fieldExecution.attention','fieldExecution.jobTime','fieldLastActionAt','fieldCompletionSync.status','fieldCompletionSync.message','fieldCompletionSync.attemptedAt','fieldCompletionSync.syncedAt'];

export async function dispatchRoster(env) {
  const profiles = listHubUserProfiles(env).map(p => ({ id: p.user.trim().toLowerCase(), name: p.displayName, role: p.role }));
  if (employeeAccountsConfigured(env)) {
    const approved = (await listEmployeeApplications(env)).filter(p => p.status === 'approved');
    profiles.push(...approved.map(p => ({ id: String(p.username || p.user || '').trim().toLowerCase(), name: p.displayName, role: 'crew' })));
  }
  const seen = new Set();
  for (const profile of profiles) {
    if (!profile.id || seen.has(profile.id)) throw failure('dispatch_roster_ambiguous', 'Employee identities need review before dispatch can safely assign work.');
    seen.add(profile.id);
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
  return {
    roster: () => dispatchRoster(env),
    jobs: () => scan('jobs', JOB_FIELDS),
    resources: () => scan('dispatchResources', null, 2000),
    customers: () => scan('customers', ['name','firstName','lastName','phone','email','address','highlevelContactId'], 20000),
    async read(collection, id) {
      const response = await send(`${BASE}/${collection}/${encodeURIComponent(id)}`);
      if (response.status === 404) return null;
      if (!response.ok) throw failure('dispatch_storage_unavailable', 'The dispatch record could not be loaded. Retry.');
      return decode(await response.json(),collection,id);
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
        await rollback();
        if ([409, 412].includes(response.status)) throw failure('dispatch_revision_conflict', 'The schedule changed while you were editing. Refresh and review the latest information.', 409);
        throw failure('dispatch_outcome_unknown', 'The save could not be verified. Retry the same request to safely check its outcome.');
      }
      return response.json();
    },
  };
}
