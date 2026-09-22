import { getHubSession, hasBusinessAccess, listHubUserProfiles } from '../_lib/hub-session.js';
import { employeeAccountsConfigured, listEmployeeApplications } from '../_lib/employee-accounts.js';
import { firebaseServiceAccountConfigured } from '../_lib/firebase-service-account.js';
import { createJobAssignmentAccess } from '../_lib/job-assignment.js';
import { fieldCommand, fieldFailure, fieldFingerprint, fieldId, fieldJobProjection, fieldPhotos, fieldRequestId, fieldStage, fieldText } from '../_lib/field-execution.js';
import { createFieldStore } from '../_lib/field-execution-store.js';
import { createFieldPhotoClient, decodeFieldPhoto, fieldPhotosConfigured, verifyFieldPhotoMetadata } from '../_lib/field-execution-photos.js';
import { syncFieldCompletion } from '../_lib/field-execution-sync.js';
import { fieldJobTime } from '../_lib/field-execution-time.js';

const reply = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
const mutationOriginAllowed = request => {
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const origin = request.headers.get('Origin') || request.headers.get('Referer');
  if (!origin) return true;
  try { return new URL(origin).origin === new URL(request.url).origin; } catch { return false; }
};
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
export const fieldToday = now => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now || new Date());

async function context(request, env) {
  const session = await getHubSession(request, env);
  if (!session) throw fieldFailure('Sign in to the Employee Hub to open your jobs.', 401, 'FIELD_AUTH_REQUIRED');
  if (!firebaseServiceAccountConfigured(env)) throw fieldFailure('Secure job storage is not connected. Contact operations.', 503, 'FIELD_STORAGE_UNAVAILABLE');
  const manager = hasBusinessAccess(session), access = createJobAssignmentAccess(env, session), store = createFieldStore(env);
  return { session, manager, access, store };
}

async function authorizedJob(ctx, id) {
  if (!fieldId(id)) throw fieldFailure('Choose a valid job.');
  const job = await ctx.store.readJob(id);
  if (!job || job.type !== 'job' || job.recordType) throw fieldFailure('This job is unavailable. Open Today for your current assignments.', 404, 'FIELD_JOB_NOT_FOUND');
  if (!ctx.manager && !await ctx.access.assigned(job)) throw fieldFailure('This job is not currently assigned to your account. Open Today for your assignments.', 403, 'FIELD_JOB_NOT_ASSIGNED');
  return job;
}

async function displayContext(ctx, env, jobs) {
  const crewNames = {};
  for (const profile of listHubUserProfiles(env)) crewNames[String(profile.user).toLowerCase()] = profile.displayName;
  // A display lookup failure must not hide an otherwise authorized workday.
  // Stable usernames remain an accurate fallback without exposing profiles.
  if (employeeAccountsConfigured(env)) {
    const profiles = await listEmployeeApplications(env).catch(() => []);
    for (const profile of profiles) if (profile.status === 'approved') crewNames[String(profile.username || profile.user).toLowerCase()] = profile.displayName;
  }
  const resourceIds = [...new Set(jobs.flatMap(job => [job.vehicleId, job.crewId]).filter(fieldId))];
  const resources = new Map(await Promise.all(resourceIds.map(async id => [id, await ctx.store.readResource(id).catch(() => null)])));
  return job => ({ manager: ctx.manager, crewNames, vehicleName: resources.get(job.vehicleId)?.name || '', crewName: resources.get(job.crewId)?.name || '' });
}

async function detail(ctx, env, jobId, cursor = '') {
  const job = await authorizedJob(ctx, jobId);
  const [history, display] = await Promise.all([ctx.store.events(jobId, cursor), displayContext(ctx, env, [job])]);
  return { job: fieldJobProjection(job, history.events, display(job)), historyCursor: history.cursor, photosAvailable: fieldPhotosConfigured(env), timezone: 'America/Denver' };
}

function errorResponse(error) {
  return reply(error.status || 503, { ok: false, code: error.code || 'FIELD_SERVICE_UNAVAILABLE', error: error.code ? error.message : 'Job services are temporarily unavailable. Your action has not been confirmed; retry to check its result.', ...(Array.isArray(error.missing) ? { missing: error.missing } : {}) });
}

export async function onRequestGet({ request, env }) {
  try {
    const ctx = await context(request, env), params = new URL(request.url).searchParams, jobId = params.get('jobId');
    if (jobId) {
      if (params.get('view') === 'timer') {
        const job = await authorizedJob(ctx, jobId);
        return reply(200, { ok: true, jobTime: fieldJobTime(job), expectedRevision: job.__updateTime });
      }
      const photoId = params.get('photoId');
      if (photoId) {
        const job = await authorizedJob(ctx, jobId), photo = fieldPhotos(job).find(photo => photo.id === photoId);
        if (!photo) throw fieldFailure('This photo is not part of the current job record.', 404, 'FIELD_PHOTO_NOT_FOUND');
        return await (await createFieldPhotoClient(env)).image(photo.fileId);
      }
      return reply(200, { ok: true, ...await detail(ctx, env, jobId, params.get('historyCursor') || '') });
    }
    const date = params.get('date') || fieldToday(), days = Number(params.get('days') || 1), status = params.get('status') || 'all';
    if (!validDate(date) || !Number.isInteger(days) || days < 1 || days > 7 || !['all', 'active', 'completed', 'cancelled'].includes(status)) throw fieldFailure('Choose a valid Mountain date, 1–7 days and a supported status filter.');
    const end = new Date(`${date}T12:00:00Z`); end.setUTCDate(end.getUTCDate() + days - 1);
    const source = await ctx.store.listDays(date, end.toISOString().slice(0, 10)), jobs = [];
    for (const job of source) {
      // This is the signed-in employee's day, including for managers. Managers
      // can open any job by ID and use dispatch for the company-wide view.
      if (!await ctx.access.assigned(job)) continue;
      const stage = fieldStage(job), completed = ['completed', 'paid', 'invoiced', 'review_requested'].includes(stage);
      if (status === 'active' && (completed || stage === 'cancelled') || status === 'completed' && !completed || status === 'cancelled' && stage !== 'cancelled') continue;
      jobs.push(job);
    }
    jobs.sort((a, b) => `${a.date} ${a.time || '99:99'}`.localeCompare(`${b.date} ${b.time || '99:99'}`) || a.id.localeCompare(b.id));
    const display = await displayContext(ctx, env, jobs);
    return reply(200, { ok: true, jobs: jobs.map(job => fieldJobProjection(job, [], display(job))), date, endDate: end.toISOString().slice(0, 10), timezone: 'America/Denver', photosAvailable: fieldPhotosConfigured(env), generatedAt: new Date().toISOString() });
  } catch (error) { return errorResponse(error); }
}

async function readInput(request) {
  const max = 9 * 1024 * 1024;
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type') || '')) throw fieldFailure('Job actions must use JSON.', 415);
  if (Number(request.headers.get('Content-Length') || 0) > max) throw fieldFailure('This upload is too large. Choose a smaller photo.', 413);
  if (!request.body) throw fieldFailure('The job action is empty.');
  const reader = request.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > max) { await reader.cancel(); throw fieldFailure('This upload is too large. Choose a smaller photo.', 413); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let body; try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw fieldFailure('The job action could not be read.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fieldFailure('Choose a supported job action.');
  if (body.action !== 'photo' && size > 64 * 1024) throw fieldFailure('This job action is too large.', 413);
  if (!fieldId(body.jobId) || !fieldRequestId(body.requestId) || typeof body.expectedRevision !== 'string' || !body.expectedRevision || body.expectedRevision.length > 80) throw fieldFailure('A job, unique action ID and current job version are required. Refresh and retry.');
  return body;
}

async function savePhoto(ctx, env, job, input, fingerprint, receipt) {
  if (!['before', 'progress', 'after', 'damage'].includes(input.category) || typeof input.caption !== 'string' || input.caption.length > 500) throw fieldFailure('Choose a photo category and a caption no longer than 500 characters.');
  if (fieldStage(job) === 'cancelled') throw fieldFailure('This job is cancelled. Ask operations before adding evidence.', 409, 'FIELD_JOB_CLOSED');
  if (fieldPhotos(job).length >= 100) throw fieldFailure('This job already has 100 field photos. Contact operations to archive photos before adding more.', 409, 'FIELD_PHOTO_LIMIT');
  const picture = decodeFieldPhoto(input.dataUrl), client = await createFieldPhotoClient(env);
  let pending = receipt;
  if (!pending) {
    const fileId = await client.allocate(), now = new Date().toISOString();
    pending = { id: input.requestId, action: 'photo', actorId: ctx.session.user, actorName: ctx.session.displayName || ctx.session.user, createdAt: now, state: 'pending', visibility: 'crew', fingerprint, fileId, category: input.category, caption: fieldText(input.caption, 500) };
    await ctx.store.commit(job, { fieldPhotoPendingAt: now }, pending);
    pending = await ctx.store.readEvent(job.id, input.requestId);
  }
  let metadata = await client.metadata(pending.fileId);
  if (!metadata) { await client.upload(pending.fileId, job.id, input.requestId, picture, input.category); metadata = await client.metadata(pending.fileId); }
  verifyFieldPhotoMetadata(metadata, { jobId: job.id, requestId: input.requestId, picture });
  // Recheck assignment after the upload and fence every update against the
  // latest job revision. Concurrent checklists and other photos are preserved.
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await authorizedJob(ctx, job.id), currentReceipt = await ctx.store.readEvent(job.id, input.requestId);
    if (currentReceipt?.state === 'applied') return;
    if (!currentReceipt || currentReceipt.fingerprint !== fingerprint) throw fieldFailure('This upload receipt changed. Contact operations.', 409, 'FIELD_IDEMPOTENCY_CONFLICT');
    if (fieldStage(latest) === 'cancelled') throw fieldFailure('The job was cancelled during upload. The photo has not been added to the job.', 409, 'FIELD_JOB_CLOSED');
    const existing = fieldPhotos(latest);
    if (existing.length >= 100) throw fieldFailure('This job already has 100 field photos. Contact operations.', 409, 'FIELD_PHOTO_LIMIT');
    const now = new Date().toISOString(), photo = { id: input.requestId, fileId: pending.fileId, category: input.category, caption: fieldText(input.caption, 500), actorId: ctx.session.user, actorName: pending.actorName, createdAt: now, verified: true, mime: picture.mime, bytes: picture.bytes.length };
    const event = { ...pending, state: 'applied', createdAt: now, photoId: photo.id, summary: `${input.category} photo uploaded`, body: photo.caption }; delete event.__updateTime;
    try { await ctx.store.commit(latest, { fieldExecution: { ...(latest.fieldExecution || {}), photos: [...existing, photo] }, updatedAt: now, fieldLastActionAt: now }, event, currentReceipt); return; }
    catch (error) { if (error.code !== 'FIELD_REVISION_CONFLICT' || attempt === 2) throw error; }
  }
}

export async function onRequestPost(handlerContext) {
  const { request, env } = handlerContext;
  let ctx, input, fingerprint;
  try {
    if (!mutationOriginAllowed(request)) throw fieldFailure('This job action must come from the Employee Hub.', 403, 'FIELD_ORIGIN_FORBIDDEN');
    ctx = await context(request, env); input = await readInput(request);
    if (input.expectedUser !== undefined && (typeof input.expectedUser !== 'string' || input.expectedUser.toLowerCase() !== ctx.session.user.toLowerCase())) throw fieldFailure('Your signed-in account changed. Sign in again before retrying this work.', 401, 'FIELD_ACCOUNT_CHANGED');
    const job = await authorizedJob(ctx, input.jobId);
    fingerprint = await fieldFingerprint(ctx.session.user, input);
    const receipt = await ctx.store.readEvent(job.id, input.requestId);
    if (receipt && receipt.fingerprint !== fingerprint) throw fieldFailure('This action ID was already used for different information. Refresh before retrying.', 409, 'FIELD_IDEMPOTENCY_CONFLICT');
    if (receipt?.state === 'applied') return reply(200, { ok: true, alreadyApplied: true, ...await detail(ctx, env, job.id) });
    if (!receipt && job.__updateTime !== input.expectedRevision) throw fieldFailure('This job changed. Refresh to review the latest assignment and details before retrying.', 409, 'FIELD_REVISION_CONFLICT');
    if (input.action === 'photo') await savePhoto(ctx, env, job, input, fingerprint, receipt);
    else if (input.action === 'retry_completion_sync') {
      if (!ctx.manager) throw fieldFailure('Only operations managers can retry the internal CRM integration.', 403);
      await syncFieldCompletion(env, job.id, { store: ctx.store, actor: ctx.session, eventId: input.requestId, fingerprint });
    }
    else {
      if (receipt) throw fieldFailure('This action is pending verification. Retry shortly.', 409, 'FIELD_ACTION_PENDING');
      const result = fieldCommand(job, { ...ctx.session, manager: ctx.manager }, input);
      await ctx.store.commit(job, result.patch, { ...result.event, fingerprint });
      if (input.action === 'complete' && typeof handlerContext.waitUntil === 'function') {
        handlerContext.waitUntil(syncFieldCompletion(env, job.id, { actor: ctx.session }));
      }
    }
    return reply(200, { ok: true, alreadyApplied: false, ...await detail(ctx, env, job.id) });
  } catch (error) {
    // Recover an applied transaction after a lost response, without asserting
    // success when the committed receipt cannot be read and verified.
    if (ctx && input && fingerprint && ['FIELD_STORAGE_UNAVAILABLE', 'FIELD_REVISION_CONFLICT'].includes(error.code)) {
      try { const receipt = await ctx.store.readEvent(input.jobId, input.requestId); if (receipt?.state === 'applied' && receipt.fingerprint === fingerprint) return reply(200, { ok: true, alreadyApplied: true, ...await detail(ctx, env, input.jobId) }); } catch { /* Original actionable error remains. */ }
    }
    return errorResponse(error);
  }
}
