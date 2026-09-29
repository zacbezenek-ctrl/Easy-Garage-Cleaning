// GHL-TRACK-1 fixtures for the browser sync path (POST /api/highlevel): a signed-in owner, an in-memory Firestore and a
// fake HighLevel that records every request. Used by the flag-off snapshot and the flag-on browser-sync checks.
import { onRequestPost as highlevelPost } from '../../functions/api/highlevel.js';
import { createHubSessionCookie } from '../../functions/_lib/hub-session.js';
import { firestoreMemory } from './firestore-memory.mjs';
import { recordingHighLevel } from './highlevel-recorder.mjs';

const NOW = '2026-09-22T18:00:00.000Z', ORIGIN = 'https://easygaragecleaning.com';
export const FLAG_OFF_ENV = Object.freeze({
  HUB_SESSION_SECRET: 'synthetic-ghl-track-session-secret-0123456789abcdef',
  HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'synthetic-zac', displayName: 'Synthetic Owner', role: 'owner', payType: 'owner', hourlyRate: 0 } }),
  HIGHLEVEL_API_KEY: 'synthetic-ghl-key', HIGHLEVEL_LOCATION_ID: 'location-1', HIGHLEVEL_WALKTHROUGH_CALENDAR_ID: 'cal-walk', HIGHLEVEL_JOB_CALENDAR_ID: 'cal-job',
  FIREBASE_API_KEY: 'firebase-test-ghl-track', EGC_OPERATIONS_ENABLED: 'false',
});

const visit = (overrides = {}) => ({ type: 'walkthrough', customerId: 'customer-1', customer: 'Synthetic Customer', phone: '9705550123', email: 'synthetic@example.invalid', address: '1 Synthetic Way, Fort Collins, CO 80521',
  date: '2026-09-25', time: '09:00', endDate: '2026-09-25', endTime: '10:00', startAt: '2026-09-25T15:00:00.000Z', endAt: '2026-09-25T16:00:00.000Z', status: 'scheduled', pipelineStatus: 'scheduled', notify: true, reminderDays: 3, ...overrides });
export const FLAG_OFF_JOBS = Object.freeze({
  'visit-walk': visit({ highlevelContactId: 'contact-1' }),
  'visit-job': visit({ type: 'job', serviceType: 'Garage transformation', notify: false, total: 1400 }),
  'visit-cancel': visit({ highlevelContactId: 'contact-1', highlevelAppointmentId: 'appt-1', status: 'cancelled', pipelineStatus: 'cancelled' }),
  'job-close': visit({ type: 'job', highlevelContactId: 'contact-1', status: 'completed', pipelineStatus: 'completed', completedAt: '2026-09-21T22:00:00.000Z' }),
  'visit-plan': visit({ highlevelContactId: 'contact-1', estimate: { status: 'sent' } }),
});

// The browser-path requests a manager's Hub sends today (employee-suite.js syncPayload, syncLifecycle, the closeout and Game Plan syncs).
export const FLAG_OFF_REQUESTS = Object.freeze([
  ['schedule walkthrough, linked contact, reminder 3d', { tool: 'schedule', job_id: 'visit-walk', idempotency_key: 'schedule:visit-walk:1', event_type: 'walkthrough', appointment_id: '', opportunity_id: '', start_time: '2026-09-25T15:00:00.000Z', end_time: '2026-09-25T16:00:00.000Z', title: 'EGC Free Walkthrough', address: '1 Synthetic Way', notes: '', notify: true, reminder_days: 3, client: { name: 'Synthetic Customer', phone: '9705550123', email: 'synthetic@example.invalid', address: '1 Synthetic Way', highlevel_contact_id: 'contact-1' } }],
  ['schedule job, no contact, notify off', { tool: 'schedule', job_id: 'visit-job', idempotency_key: 'schedule:visit-job:1', event_type: 'job', appointment_id: '', opportunity_id: '', opportunity_name: 'Synthetic Customer — Garage transformation', monetary_value: 1400, start_time: '2026-09-25T15:00:00.000Z', end_time: '2026-09-25T16:00:00.000Z', title: 'Garage transformation', address: '1 Synthetic Way', notes: '', notify: false, reminder_days: 2, client: { name: 'Synthetic Customer', phone: '9705550123', email: 'synthetic@example.invalid', address: '1 Synthetic Way', highlevel_contact_id: '' } }],
  ['schedule a cancelled visit', { tool: 'schedule', job_id: 'visit-cancel', idempotency_key: 'schedule:visit-cancel:2', event_type: 'walkthrough', appointment_id: 'appt-1', start_time: '2026-09-25T15:00:00.000Z', end_time: '2026-09-25T16:00:00.000Z', notify: true, reminder_days: 3, client: { name: 'Synthetic Customer', highlevel_contact_id: 'contact-1' } }],
  ['lifecycle cancellation with appointment and note', { tool: 'lifecycle', event: 'job-cancelled', job_id: 'visit-cancel', idempotency_key: 'lifecycle:visit-cancel:job-cancelled:1', highlevel_contact_id: 'contact-1', appointment_id: 'appt-1', appointment_status: 'cancelled', note: 'Cancellation reason: synthetic', client: { name: 'Synthetic Customer', highlevel_contact_id: 'contact-1' } }],
  ['closeout', { tool: 'post_job', job_id: 'job-close', idempotency_key: 'closeout:job-close:1', sent_at: '2026-09-22T17:00:00.000Z', completed_at: '2026-09-21T22:00:00.000Z', job: { customer: 'Synthetic Customer', highlevel_contact_id: 'contact-1', locked_total: 1400, notes: 'Synthetic closeout' }, payment: { amount_received: 0, paid_to_date: 0, balance: 1400 } }],
  ['game plan with a job date', { tool: 'game_plan', job_id: 'visit-plan', idempotency_key: 'plan:visit-plan:1', sent_at: '2026-09-22T17:30:00.000Z', client: { name: 'Synthetic Customer', phone: '9705550123', email: 'synthetic@example.invalid', address: '1 Synthetic Way', highlevel_contact_id: 'contact-1', highlevel_appointment_id: 'appt-walk' }, quote: { total: 1400, deposit: 0, job_date: '2026-10-01', start_time: '08:00', end_time: '12:00', start_at: '2026-10-01T14:00:00.000Z', end_at: '2026-10-01T18:00:00.000Z' }, scope: { keep_items: 'Synthetic keep' } }],
]);

/** Runs FLAG_OFF_REQUESTS against /api/highlevel and returns the HighLevel request log, one line per request. `documents`
 * seeds other Firestore documents by path, and `seed(memory, ghl)` runs once before the requests. Background work a
 * request hands to waitUntil finishes before the next request, and its HighLevel requests count as that request's. */
export async function highLevelRequestLog(t, env = FLAG_OFF_ENV, jobs = FLAG_OFF_JOBS, requests = FLAG_OFF_REQUESTS, { documents = {}, seed = null } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const ghl = recordingHighLevel(), memory = firestoreMemory({ fallback: ghl.fetcher });
  for (const [id, job] of Object.entries(jobs)) memory.put(`jobs/${id}`, job);
  for (const [path, data] of Object.entries(documents)) memory.put(path, data);
  t.mock.method(globalThis, 'fetch', (input, options) => memory.fetch(input, options));
  if (seed) await seed(memory, ghl);
  const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0], log = [];
  const responses = [];
  for (const [label, payload] of requests) {
    const before = ghl.calls.length, background = [];
    const response = await highlevelPost({ request: new Request(`${ORIGIN}/api/highlevel`, { method: 'POST', headers: { Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }), env, waitUntil: promise => background.push(promise) });
    await Promise.all(background);
    responses.push({ label, status: response.status, body: await response.clone().json(), calls: ghl.calls.slice(before) });
    log.push(`## ${label} -> ${response.status}`, ...ghl.calls.slice(before).map(call => JSON.stringify(call)));
  }
  return { text: `${log.join('\n')}\n`, calls: ghl.calls, responses, memory };
}
