import { can } from './staff-roles.js';
import { mutateDispatch } from './dispatch-service.js';
import { stripCrewMoneyDeep } from './crew-money.js';

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (message, status = 403) => Object.assign(new Error(message), { status, code: 'dispatch_job_operations_forbidden' });
export function requireJobOperations(session, env = {}) {
  if (!session) throw fail('Sign in to manage jobs.', 401);
  if (!can(session, 'jobs.operate', env)) throw fail('Job operations access is required.');
}
export const jobOperationsAuthorize = env => session => requireJobOperations(session, env);
export const operationalJob = job => Boolean(job && !job.recordType && ['job', 'cleanout', 'reorg'].includes(job.type));
const scalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined && scalar(value[key])).map(key => [key, value[key]]));
const strings = (value, keys) => Object.fromEntries(keys.filter(key => Array.isArray(value?.[key])).map(key => [key, value[key].filter(item => typeof item === 'string')]));
// Never spread stored records, financial readiness, provider payloads, raw notes,
// materials (which may carry purchase prices), timecards or roster profiles.
const JOB_FIELDS = ['id', 'revision', 'type', 'customerId', 'customer', 'phone', 'address', 'title', 'date', 'time', 'endDate', 'endTime', 'status', 'assignedCrew', 'crewLead', 'crewId', 'vehicleId', 'crewNeeded', 'travelBufferMinutes', 'jobInstructions', 'accessInstructions', 'customerInstructions', 'serviceType', 'requiredEquipment', 'requiredSkills', 'arrivalWindowStart', 'arrivalWindowEnd', 'timeZone'];
const SEGMENT_FIELDS = ['id', 'date', 'time', 'endDate', 'endTime', 'assignedCrew', 'crewLead', 'crewId', 'vehicleId'];
export function projectOperationalJob(job) {
  return stripCrewMoneyDeep({ ...pick(job, JOB_FIELDS), ...strings(job, ['assignedCrew', 'requiredEquipment', 'requiredSkills']), ...(Array.isArray(job?.assignmentSegments) ? { assignmentSegments: job.assignmentSegments.map(segment => ({ ...pick(segment, SEGMENT_FIELDS), ...strings(segment, ['assignedCrew']) })) } : {}) });
}
export function projectOperationalResult(result) {
  return stripCrewMoneyDeep({ ...pick(result, ['ok', 'requestId', 'replayed', 'startDate', 'endDate', 'timeZone', 'total', 'truncated', 'query', 'status', 'coverage', 'arrivalDefaults', 'segments']),
    ...(result.coverage ? { coverage: pick(result.coverage, ['complete', 'asOf']) } : {}),
    ...(result.arrivalDefaults ? { arrivalDefaults: pick(result.arrivalDefaults, ['enabled', 'minutes']) } : {}),
    ...(result.segments ? { segments: pick(result.segments, ['enabled', 'max']) } : {}),
    ...(result.job ? { job: projectOperationalJob(result.job) } : {}),
    ...(result.jobs ? { jobs: result.jobs.filter(operationalJob).map(projectOperationalJob) } : {}),
    ...(result.results ? { results: result.results.filter(row => operationalJob(row.job)).map(row => ({ job: projectOperationalJob(row.job) })) } : {}),
    ...(result.customers ? { customers: result.customers.map(row => pick(row, ['id', 'name', 'phone', 'email', 'address'])) } : {}),
    ...(result.roster ? { roster: result.roster.map(row => pick(row, ['id', 'name'])) } : {}),
    ...(result.crews ? { crews: result.crews.map(row => ({ ...pick(row, ['id', 'name', 'leadId', 'status']), ...strings(row, ['memberIds']) })) } : {}),
    ...(result.vehicles ? { vehicles: result.vehicles.map(row => pick(row, ['id', 'name', 'status'])) } : {}),
    // Warning codes and affected records suffice; free-form warning text can quote private notes.
    ...(result.warnings ? { warnings: result.warnings.map(row => pick(row, ['code', 'jobId', 'employeeId', 'vehicleId', 'blocking'])) } : {}) });
}
export const JOB_OPERATION_FIELDS = Object.freeze(['date', 'time', 'endDate', 'endTime', 'assignedCrew', 'crewLead', 'crewId', 'vehicleId', 'crewNeeded', 'travelBufferMinutes', 'title', 'address', 'serviceType', 'jobInstructions', 'accessInstructions', 'customerInstructions', 'requiredEquipment', 'requiredSkills', 'arrivalWindowStart', 'arrivalWindowEnd', 'assignmentSegments']);
const INPUT_FIELDS = ['action', 'requestId', 'customerId', 'kind', 'jobId', 'expectedRevision', 'changes', 'cancellationReason', 'reasonCode', 'initiatedBy', 'expectedUser', 'sourceJobId'];
const only = (value, keys) => { if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail('This job operation contains unsupported fields.'); };
export async function mutateJobOperation(store, session, input, now, env = {}, options = {}) {
  requireJobOperations(session, env);
  only(input, INPUT_FIELDS);
  if (!['schedule.create', 'schedule.update', 'schedule.cancel'].includes(input.action)) throw fail('Choose create, edit, assign, schedule or cancel.');
  if (input.expectedUser !== session.user) throw fail('The signed-in account changed. Refresh before saving.', 401);
  only(input.changes, JOB_OPERATION_FIELDS);
  if (input.changes.assignmentSegments !== undefined) {
    if (!Array.isArray(input.changes.assignmentSegments)) throw fail('Choose valid assignment segments.', 400);
    input.changes.assignmentSegments.forEach(segment => only(segment, SEGMENT_FIELDS));
  }
  if (input.action === 'schedule.create') {
    if (input.kind !== 'job') throw fail('Only operational jobs can be created here.');
    if (input.sourceJobId && (!/^[A-Za-z0-9_-]{1,180}$/.test(input.sourceJobId) || !operationalJob(await store.read('jobs', input.sourceJobId)))) throw fail('Choose an operational source job.');
  } else {
    if (typeof input.jobId !== 'string' || !/^[A-Za-z0-9_-]{1,180}$/.test(input.jobId) || /^(secure_|_egc_)/.test(input.jobId)) throw fail('Choose a valid operational job.');
    const job = await store.read('jobs', input.jobId);
    if (!operationalJob(job)) throw fail('Only operational jobs can be changed here.');
  }
  const { expectedUser, ...command } = input;
  // Keep the guard, revision fencing, day locks, conflict checks and receipts.
  // This path creates no customer communication outbox entries. Existing flags
  // and queues for office operations are untouched.
  const scopedStore = { ...store, ghlTagOutbox: false, ghlScheduleMirror: false, notifyImportedOn: false };
  const result = await mutateDispatch(scopedStore, session, command, now, { ...options, preserveSegmentNotes: true, authorize: jobOperationsAuthorize(env) });
  return projectOperationalResult(result);
}
