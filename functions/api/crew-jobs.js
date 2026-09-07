import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { decodeFirestoreFields, patchJob, readJob } from '../_lib/firestore-job.js';
import { firebaseServiceAccountConfigured, firestoreFetch } from '../_lib/firebase-service-account.js';
import { appendConversationMessage, cleanMessage, cleanRequestId, conversationMessages, deliverHighLevelMessage, findConversationMessage, replaceConversationMessage } from '../_lib/customer-messaging.js';
import { createJobAssignmentAccess, jobCrewNames as crewNames } from '../_lib/job-assignment.js';

const PROJECT_ID = 'egcw-1ec83';

const reply = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

function allowed(request) {
  const raw = request.headers.get('Origin') || request.headers.get('Referer');
  if (!raw) return true;
  try {
    const hostname = new URL(raw).hostname;
    return ['easygaragecleaning.com', 'www.easygaragecleaning.com', 'easy-garage-cleaning.pages.dev', 'localhost', '127.0.0.1'].includes(hostname.toLowerCase());
  } catch {
    return false;
  }
}

function pickupEnabled(job) {
  return job.type === 'job' && job.shiftPickupEnabled === true;
}

function availableOpenShift(job) {
  return pickupEnabled(job) && job.openShift === true;
}

function pickupStageOpen(job) {
  return !['dispatched', 'arrived', 'in_progress', 'completed', 'invoiced', 'paid', 'review_requested', 'cancelled']
    .includes(String(job.pipelineStatus || job.status || 'scheduled').toLowerCase());
}

function crewCapacity(job) {
  const value = Number(job.crewNeeded ?? job.crewSize ?? 1);
  return Number.isFinite(value) ? Math.max(1, Math.min(20, Math.ceil(value))) : 1;
}

async function availabilityOwner(job, access) {
  return job.type === 'availability' && await access.matches(job.employee);
}

function publicOpenShift(job) {
  const assignedCount = crewNames(job).length;
  return {
    id: job.id,
    type: 'job',
    status: job.status || 'scheduled',
    pipelineStatus: job.pipelineStatus || job.status || 'scheduled',
    date: job.date || '',
    time: job.time || '',
    endTime: job.endTime || '',
    serviceType: job.serviceType || 'Garage service',
    customer: 'Open shift',
    address: '',
    assignedTo: '',
    assignedCrew: [],
    assignedCount,
    crewNeeded: crewCapacity(job),
    openShift: job.openShift === true,
    shiftPickupEnabled: job.shiftPickupEnabled === true,
  };
}

function minutes(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function overlaps(leftStart, leftEnd, rightStart, rightEnd) {
  return [leftStart, leftEnd, rightStart, rightEnd].every(Number.isFinite) && leftStart < rightEnd && rightStart < leftEnd;
}

async function scheduleConflict(env, job, access) {
  if (!job.date) return null;
  const response = await firestoreFetch(
    env,
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'jobs' }], limit: 500 } }),
    },
  );
  if (!response.ok) throw new Error('Schedule storage is unavailable');
  const start = minutes(job.time);
  const end = minutes(job.endTime);
  const rows = (await response.json())
    .filter(row => row.document?.fields)
    .map(row => ({ id: String(row.document.name || '').split('/').pop() || '', ...decodeFirestoreFields(row.document.fields) }));
  for (const row of rows) {
    if (row.id !== job.id && row.date === job.date &&
      !['cancelled', 'completed', 'paid'].includes(String(row.status || row.pipelineStatus || '').toLowerCase()) &&
      overlaps(start, end, minutes(row.time), minutes(row.endTime)) &&
      (await availabilityOwner(row, access) || await access.assigned(row))) return row;
  }
  return null;
}

export async function onRequestGet({ request, env }) {
  const session = await getHubSession(request, env);
  if (!session) return reply(401, { ok: false, error: 'Sign in required' });
  if (!firebaseServiceAccountConfigured(env)) return reply(503, { ok: false, error: 'Secure data access is not configured' });

  const response = await firestoreFetch(
    env,
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'jobs' }], limit: 500 } }),
    },
  );
  if (!response.ok) return reply(502, { ok: false, error: 'Schedule storage is unavailable' });

  const manager = hasBusinessAccess(session);
  const access = createJobAssignmentAccess(env, session);
  const rows = (await response.json())
    .filter(row => row.document?.fields)
    .map(row => ({ id: String(row.document.name || '').split('/').pop() || '', ...decodeFirestoreFields(row.document.fields) }))
    .filter(job => job.recordType !== 'schedule_lock' && job.recordType !== 'employee_hub_v2' && !job.id.startsWith('secure_'));
  const jobs = [];
  for (const job of rows) {
    if (manager || await access.assigned(job) || await availabilityOwner(job, access)) jobs.push(job);
    else if (availableOpenShift(job)) jobs.push(publicOpenShift(job));
  }

  return reply(200, { ok: true, jobs });
}

export async function onRequestPost({ request, env }) {
  if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
  const session = await getHubSession(request, env);
  if (!session) return reply(401, { ok: false, error: 'Sign in required' });
  if (!firebaseServiceAccountConfigured(env)) return reply(503, { ok: false, error: 'Secure data access is not configured' });

  const raw = await request.text();
  if (raw.length > 8192) return reply(413, { ok: false, error: 'Payload too large' });
  let payload;
  try { payload = JSON.parse(raw); } catch { return reply(400, { ok: false, error: 'Invalid JSON' }); }
  const action = String(payload.action || '');
  const jobId = String(payload.jobId || '');
  if (!['claim', 'release', 'send_customer_message'].includes(action) || !/^[A-Za-z0-9_-]{1,180}$/.test(jobId)) {
    return reply(400, { ok: false, error: 'A valid shift action and job are required' });
  }

  const job = await readJob(env, jobId).catch(() => null);
  if (!job) return reply(404, { ok: false, error: 'This shift no longer exists' });
  const access = createJobAssignmentAccess(env, session);

  if (action === 'send_customer_message') {
    if (!hasBusinessAccess(session) && !await access.assigned(job)) return reply(403, { ok: false, error: 'Only assigned crew and managers can message this customer' });
    const body = cleanMessage(payload.body), requestId = cleanRequestId(payload.requestId);
    if (!body) return reply(400, { ok: false, error: 'Write a message before sending' });
    if (!requestId) return reply(400, { ok: false, error: 'A valid message request ID is required' });
    const duplicate = findConversationMessage(job, { requestId });
    if (duplicate) return reply(200, { ok: true, duplicate: true, message: duplicate, job: { ...job, customerConversation: conversationMessages(job) } });
    const now = new Date().toISOString(), identity = String(session.displayName || session.user || 'Easy Garage Cleaning').trim();
    const message = {
      id: `crew-${requestId}`.slice(0, 140), requestId, direction: 'to_customer',
      authorRole: hasBusinessAccess(session) ? 'manager' : 'crew', authorName: identity,
      body, createdAt: now, delivery: { channel: 'sms', status: 'queued', attemptedAt: '' },
    };
    let queued;
    try {
      queued = await patchJob(env, jobId, { customerConversation: appendConversationMessage(job, message), customerConversationUpdatedAt: now, updatedAt: now }, job.__updateTime);
    } catch {
      return reply(409, { ok: false, error: 'The customer thread changed. Refresh and send again.' });
    }
    const delivery = await deliverHighLevelMessage(env, queued, { body, direction: 'to_customer' });
    let updated = queued;
    try {
      const latest = await readJob(env, jobId);
      updated = await patchJob(env, jobId, { customerConversation: replaceConversationMessage(latest, message.id, { delivery }), customerConversationUpdatedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, latest.__updateTime);
    } catch { /* The queued portal message remains visible and can be retried safely. */ }
    return reply(200, { ok: true, message: { ...message, delivery }, job: { ...updated, customerConversation: conversationMessages(updated) } });
  }

  if (!pickupEnabled(job) || !pickupStageOpen(job)) return reply(409, { ok: false, error: 'This shift is no longer open' });

  const identity = String(session.user || '').trim();
  const crew = crewNames(job);
  const isAssigned = await access.assigned(job);
  const claims = Array.isArray(job.shiftClaims) ? job.shiftClaims : [];
  const ownClaims = await Promise.all(claims.map(item => access.matches(item?.employee || item)));
  const claimedByUser = ownClaims.some(Boolean) || await access.matches(job.lastShiftClaim?.employee);
  const needed = crewCapacity(job);

  if (action === 'claim' && job.openShift !== true) return reply(409, { ok: false, error: 'This shift is no longer open' });
  if (action === 'claim' && isAssigned) return reply(409, { ok: false, error: 'You already picked up this shift' });
  if (action === 'claim' && crew.length >= needed) return reply(409, { ok: false, error: 'This shift is already full' });
  if (action === 'release' && (!isAssigned || !claimedByUser)) {
    return reply(403, { ok: false, error: 'Only the employee who picked up this shift can release it' });
  }
  if (action === 'claim') {
    let conflict;
    try { conflict = await scheduleConflict(env, job, access); }
    catch { return reply(502, { ok: false, error: 'The schedule could not be checked' }); }
    if (conflict) return reply(409, { ok: false, error: 'This shift overlaps your existing schedule or unavailable time' });
  }

  const now = new Date().toISOString();
  const ownCrew = await Promise.all(crew.map(name => access.matches(name)));
  const assignedCrew = action === 'claim' ? [...crew, identity] : crew.filter((name, index) => !ownCrew[index]);
  const nextClaims = action === 'claim'
    ? [...claims.filter((item, index) => !ownClaims[index]), { employee: identity, claimedAt: now }]
    : claims.filter((item, index) => !ownClaims[index]);
  const patch = {
    assignedCrew,
    assignedTo: assignedCrew.join(' + '),
    crewSize: needed,
    openShift: assignedCrew.length < needed,
    shiftPickupEnabled: true,
    shiftClaims: nextClaims,
    ...(action === 'claim' ? { lastShiftClaim: { employee: identity, claimedAt: now } } : { lastShiftRelease: { employee: identity, releasedAt: now } }),
    syncStatus: 'pending',
    syncIdempotencyKey: `crew-${action}:${jobId}:${now}`,
    updatedAt: now,
  };

  try {
    const updated = await patchJob(env, jobId, patch, job.__updateTime);
    return reply(200, { ok: true, action, job: action === 'claim' ? updated : publicOpenShift(updated) });
  } catch (error) {
    if (/412|409|precondition/i.test(String(error?.message || ''))) {
      return reply(409, { ok: false, error: 'The shift changed while you were viewing it. Refresh and try again.' });
    }
    return reply(502, { ok: false, error: 'The shift could not be updated' });
  }
}
