import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { patchJob, readJob } from '../_lib/firestore-job.js';
import { firebaseServiceAccountConfigured } from '../_lib/firebase-service-account.js';
import { appendConversationMessage, cleanMessage, cleanRequestId, conversationMessages, deliverHighLevelMessage, findConversationMessage, replaceConversationMessage } from '../_lib/customer-messaging.js';
import { createJobAssignmentAccess, jobCrewNames as crewNames } from '../_lib/job-assignment.js';
import { crewJobProjection, CREW_PROJECTION_FIELDS } from '../_lib/crew-job-projection.js';
import { dispatchStorage } from '../_lib/dispatch-storage.js';
import { mutateDispatchSelfAssignment } from '../_lib/dispatch-service.js';

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

// Operational readers never expose locks, receipts, encrypted Hub records or
// other private record types. Native crew availability stays owner-visible.
function privateRecord(job) {
  return /^(_egc_|secure_)/.test(job.id) || Boolean(job.recordType) && job.recordType !== 'crew_availability';
}

// The listing scans the whole jobs collection, so it loads only the fields its
// readers use; raw bodies carry base64 signatures, payment evidence and
// provider payloads. id and revision come from document metadata.
// - filtering: privateRecord, availabilityOwner, access.assigned, availableOpenShift
// - crew rows: CREW_PROJECTION_FIELDS (crewJobProjection/fieldJobProjection)
// - other crew's open shifts: publicOpenShift
// - managers receive the masked row itself. Its readers are crew/index.html
//   (next assigned work) and copilot.html (today's strip plus the schedule it
//   forwards to /api/copilot). employee.html refreshCrewSchedule runs for crew only.
const FILTER_FIELDS = ['type', 'recordType', 'status', 'pipelineStatus', 'date', 'endDate', 'employee', 'assignedCrew', 'assignedTo', 'shiftPickupEnabled', 'openShift'];
const OPEN_SHIFT_FIELDS = ['time', 'endTime', 'serviceType', 'crewNeeded', 'crewSize'];
const MANAGER_VIEW_FIELDS = ['customer', 'address', 'time', 'endTime', 'serviceType',
  'customerName', 'name', 'timeWindow', 'scheduledTime', 'quoteAmount', 'total', 'priceQuoted', 'amount', 'cubicYards',
  'customerAddress', 'customerPhone', 'phone', 'notes'];
export const CREW_LISTING_FIELDS = Object.freeze([...new Set([...FILTER_FIELDS, ...CREW_PROJECTION_FIELDS, ...OPEN_SHIFT_FIELDS, ...MANAGER_VIEW_FIELDS])]);

export function crewJobsHandlers({ session = getHubSession, storage = dispatchStorage, now = () => new Date() } = {}) {
  return {
    async get({ request, env }) {
      const actor = await session(request, env);
      if (!actor) return reply(401, { ok: false, error: 'Sign in required' });
      if (!firebaseServiceAccountConfigured(env)) return reply(503, { ok: false, error: 'Secure data access is not configured' });
      let rows;
      try { rows = await storage(env).jobRecords(CREW_LISTING_FIELDS); }
      catch (error) { return reply(503, { ok: false, code: error.code || 'schedule_storage_unavailable', error: error.code ? error.message : 'Schedule storage is unavailable' }); }
      const manager = hasBusinessAccess(actor);
      const access = createJobAssignmentAccess(env, actor);
      const jobs = [];
      for (const job of rows.filter(row => !privateRecord(row))) {
        if (manager || await access.assigned(job) || await availabilityOwner(job, access)) jobs.push(manager ? job : crewJobProjection(job, { viewer: actor.user }));
        else if (availableOpenShift(job)) jobs.push(publicOpenShift(job));
      }
      return reply(200, { ok: true, jobs, coverage: { complete: true, asOf: now().toISOString() } });
    },

    async post({ request, env }) {
      if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
      const actor = await session(request, env);
      if (!actor) return reply(401, { ok: false, error: 'Sign in required' });
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
      const access = createJobAssignmentAccess(env, actor);

      if (action === 'send_customer_message') {
        if (!hasBusinessAccess(actor) && !await access.assigned(job)) return reply(403, { ok: false, error: 'Only assigned crew and managers can message this customer' });
        const body = cleanMessage(payload.body), requestId = cleanRequestId(payload.requestId);
        if (!body) return reply(400, { ok: false, error: 'Write a message before sending' });
        if (!requestId) return reply(400, { ok: false, error: 'A valid message request ID is required' });
        const duplicate = findConversationMessage(job, { requestId });
        if (duplicate) return reply(200, { ok: true, duplicate: true, message: duplicate, job: hasBusinessAccess(actor) ? { ...job, customerConversation: conversationMessages(job) } : crewJobProjection(job, { viewer: actor.user }) });
        const queuedAt = now().toISOString(), identity = String(actor.displayName || actor.user || 'Easy Garage Cleaning').trim();
        const message = {
          id: `crew-${requestId}`.slice(0, 140), requestId, direction: 'to_customer',
          authorRole: hasBusinessAccess(actor) ? 'manager' : 'crew', authorName: identity,
          body, createdAt: queuedAt, delivery: { channel: 'sms', status: 'queued', attemptedAt: '' },
        };
        let queued;
        try {
          queued = await patchJob(env, jobId, { customerConversation: appendConversationMessage(job, message), customerConversationUpdatedAt: queuedAt, updatedAt: queuedAt }, job.__updateTime);
        } catch {
          return reply(409, { ok: false, error: 'The customer thread changed. Refresh and send again.' });
        }
        const delivery = await deliverHighLevelMessage(env, queued, { body, direction: 'to_customer' });
        let updated = queued;
        try {
          const latest = await readJob(env, jobId), deliveredAt = now().toISOString();
          updated = await patchJob(env, jobId, { customerConversation: replaceConversationMessage(latest, message.id, { delivery }), customerConversationUpdatedAt: deliveredAt, updatedAt: deliveredAt }, latest.__updateTime);
        } catch { /* The queued portal message remains visible and can be retried safely. */ }
        return reply(200, { ok: true, message: { ...message, delivery }, job: hasBusinessAccess(actor) ? { ...updated, customerConversation: conversationMessages(updated) } : crewJobProjection(updated, { viewer: actor.user }) });
      }

      try {
        const result = await mutateDispatchSelfAssignment(storage(env), actor, {
          action, jobId, requestId: payload.requestId,
          ...(payload.expectedRevision ? { expectedRevision: payload.expectedRevision } : {}),
        }, now().toISOString());
        return reply(200, { ok: true, action, replayed: result.replayed === true,
          job: action === 'claim' ? (hasBusinessAccess(actor) ? result.job : crewJobProjection(result.job, { viewer: actor.user })) : publicOpenShift(result.job),
          // Additive: travel-buffer and legacy calendar-block notices for this shift.
          warnings: Array.isArray(result.warnings) ? result.warnings : [],
        });
      } catch (error) {
        return reply(error.status || 503, { ok: false, code: error.code || 'shift_update_unavailable', error: error.code ? error.message : 'The shift could not be confirmed. Retry the same action.', ...(error.details ? { details: error.details } : {}) });
      }
    },
  };
}

const handlers = crewJobsHandlers();
export const onRequestGet = handlers.get;
export const onRequestPost = handlers.post;
