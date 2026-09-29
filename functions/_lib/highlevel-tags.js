/* HighLevel contact, tag and appointment-status writes shared by the Hub's
   browser sync (functions/api/highlevel.js) and the GHL-TRACK-1 tag outbox
   (functions/_lib/ghl-tag-outbox.js). Moved unchanged from highlevel.js, so
   every request keeps its path, headers and body. Nothing here sends a
   customer message: tags and appointment status are what HighLevel's own
   workflows react to. */
import { customerCalendars, isStaffScheduledCalendar } from './highlevel-calendars.js';

export const HIGHLEVEL_API = 'https://services.leadconnectorhq.com';
/** EGC_GHL_TAG_OUTBOX: exactly "true" queues schedule and walkthrough-outcome tags in the tag outbox (ghl-tag-outbox.js). */
export const ghlTagOutboxEnabled = env => env?.EGC_GHL_TAG_OUTBOX === 'true';

export function highLevelConfig(env) {
  return {
    token: env.HIGHLEVEL_API_KEY || env.GHL_API_KEY || '',
    locationId: env.HIGHLEVEL_LOCATION_ID || env.GHL_LOCATION_ID || '',
    ...customerCalendars(env),
    pipelineId: env.HIGHLEVEL_PIPELINE_ID || env.GHL_PIPELINE_ID || 'anSgrMpYHtAX6YlUHnIR',
    scheduledStageId: env.HIGHLEVEL_SCHEDULED_STAGE_ID || env.GHL_SCHEDULED_STAGE_ID || env.HIGHLEVEL_PIPELINE_STAGE_SCHEDULED_ID || env.GHL_PIPELINE_STAGE_SCHEDULED_ID || '06b78f36-b53d-4028-9e36-b41ac4d2da09',
    walkthroughCompleteStageId: env.HIGHLEVEL_QUOTED_STAGE_ID || env.GHL_QUOTED_STAGE_ID || env.HIGHLEVEL_PIPELINE_STAGE_WALKTHROUGH_COMPLETE_ID || env.GHL_PIPELINE_STAGE_WALKTHROUGH_COMPLETE_ID || '85c56b3e-4886-4fc1-be95-87ad0b0d2bcc',
    jobCompleteStageId: env.HIGHLEVEL_COMPLETE_STAGE_ID || env.GHL_COMPLETE_STAGE_ID || env.HIGHLEVEL_PIPELINE_STAGE_JOB_COMPLETE_ID || env.GHL_PIPELINE_STAGE_JOB_COMPLETE_ID || '0ccca1f9-3ffb-412a-b15a-3f4be1619514',
    userId: env.HIGHLEVEL_USER_ID || env.GHL_USER_ID || 'w92vfhwm3a8twTIowpQz',
  };
}

// c.fetch (tests, the outbox drain) replaces the global fetch; every other request field is unchanged.
export async function ghl(c, path, options = {}) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${c.token}`,
    Version: 'v3',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
  };
  const response = await (c.fetch || fetch)(HIGHLEVEL_API + path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`HighLevel returned ${response.status}`);
    error.status = response.status;
    error.detail = JSON.stringify(data).slice(0, 400);
    throw error;
  }
  return data;
}

export async function ensureContact(c, client, source = 'EGC Hub') {
  let contactId = client.highlevel_contact_id || client.ghl_contact_id || client.contactId || '';
  if (contactId) return contactId;
  const upsert = await ghl(c, '/contacts/upsert', { method: 'POST', body: JSON.stringify({
    locationId: c.locationId, name: client.name || client.customer || '', phone: client.phone || '', email: client.email || '',
    address1: client.address || '', source: client.lead_source || source
  })});
  return upsert.contact?.id || '';
}

export async function addTags(c, contactId, tags) {
  const clean = [...new Set((tags || []).filter(Boolean))];
  if (!clean.length) return;
  await ghl(c, `/contacts/${encodeURIComponent(contactId)}/tags`, { method: 'POST', body: JSON.stringify({ tags: clean }) });
}

export async function completeAppointment(c, appointmentId, targetStatus = 'completed') {
  if (!appointmentId) return { updated: false, reason: 'appointment-not-linked' };
  try {
    const path = `/calendars/events/appointments/${encodeURIComponent(appointmentId)}`;
    const currentResult = await ghl(c, path);
    const current = currentResult.appointment || currentResult.event || currentResult;
    await ghl(c, path, {
      method: 'PUT', body: JSON.stringify({
        calendarId: current.calendarId,
        title: current.title || 'EGC Free Walkthrough',
        startTime: current.startTime,
        endTime: current.endTime,
        address: current.address || '',
        description: current.description || current.notes || '',
        assignedUserId: current.assignedUserId || c.userId || undefined,
        appointmentStatus: targetStatus,
        toNotify: false,
        ...(isStaffScheduledCalendar(current.calendarId) ? { ignoreFreeSlotValidation: true } : {}),
      }),
    });
    return { updated: true, appointmentId, appointmentStatus: targetStatus };
  } catch (error) {
    return { updated: false, reason: 'update-failed', detail: error.detail || error.message };
  }
}

// An internal contact note (the tag outbox's walkthrough-lost reason), pinned off, as highlevel.js writes lifecycle notes.
export async function addContactNote(c, contactId, { title, body, idempotencyKey = '' }) {
  const note = await ghl(c, `/contacts/${encodeURIComponent(contactId)}/notes`, { method: 'POST', headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}, body: JSON.stringify({ userId: c.userId || undefined, title, body: String(body).slice(0, 3000), color: '#F15A24', pinned: false }) });
  return note.note?.id || '';
}
