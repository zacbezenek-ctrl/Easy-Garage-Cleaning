import { firebaseServiceAccountConfigured, firestoreFetch } from './firebase-service-account.js';
import { readJob, patchJob, decodeFirestoreFields, encodeFirestoreFields } from './firestore-job.js';
import { customerCalendars } from './highlevel-calendars.js';

const API = 'https://services.leadconnectorhq.com';
const DB = 'https://firestore.googleapis.com/v1/projects/egcw-1ec83/databases/(default)/documents';
const EMPLOYEE_CALENDAR = '2yYX63nHYvUsL6KKhAc0';
const phone = value => { const digits = String(value || '').replace(/\D/g, ''); return digits.length === 10 ? `1${digits}` : digits; };
const email = value => String(value || '').trim().toLowerCase();
const inactive = job => [job.status, job.pipelineStatus].some(x => ['cancelled', 'canceled', 'superseded', 'completed', 'paid', 'lost'].includes(String(x || '').toLowerCase()));

export function salesExitMilestone(job = {}) {
  if (!job) return '';
  if (job.type !== 'job' || [job.status, job.pipelineStatus].some(x => ['cancelled', 'canceled', 'superseded'].includes(String(x || '').toLowerCase()))) return '';
  if ((job.completedAt || job.postJobChecklist?.completedAt) && [job.status, job.pipelineStatus].some(x => ['completed', 'paid', 'invoiced', 'review_requested'].includes(String(x || '').toLowerCase()))) return 'completed';
  if (String(job.customerApproval?.status || '').toLowerCase() === 'superseded') return '';
  if (['accepted', 'approved'].includes(String(job.estimate?.status || '').toLowerCase()) && Number(job.estimate?.amount || job.total || job.priceQuoted || 0) > 0) return 'accepted';
  if (!job.estimate?.status && job.acceptance?.signatureCaptured && job.acceptance?.acceptedAt && Number(job.total || job.priceQuoted || 0) > 0) return 'accepted';
  if (job.highlevelAppointmentId && job.date && job.time && job.endTime && ['scheduled', 'confirmed'].includes(String(job.pipelineStatus || job.status || '').toLowerCase())) return 'booked';
  return '';
}

export function salesExitService(job = {}) {
  if (!job) return '';
  const name = String(job.serviceType || '').toLowerCase();
  const garage = /garage/.test(name), junk = /junk|curb.?side/.test(name);
  return garage !== junk ? (garage ? 'garage' : 'junk') : '';
}

function sameCustomer(left, right) {
  return Boolean(left.highlevelContactId && left.highlevelContactId === right.highlevelContactId) ||
    Boolean(phone(left.phone) && phone(left.phone) === phone(right.phone)) || Boolean(email(left.email) && email(left.email) === email(right.email));
}

async function highlevel(env, path, options = {}) {
  const response = await fetch(API + path, { ...options, signal: AbortSignal.timeout(15000), headers: {
    Authorization: `Bearer ${env.HIGHLEVEL_API_KEY || env.GHL_API_KEY}`, Version: 'v3', Accept: 'application/json', 'Content-Type': 'application/json',
  } });
  if (!response.ok) { const error = new Error('HighLevel verification unavailable'); error.status = response.status; throw error; }
  return response.json().catch(() => ({}));
}

// Read the complete bounded job inventory, including records not linked to GHL
// yet. A full page is not proof that there are no other matching customer jobs.
async function allJobs(env) {
  const response = await firestoreFetch(env, `${DB}:runQuery`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: 'jobs' }], limit: 501 } }) });
  if (!response.ok) throw new Error('Job verification unavailable');
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error('Job inventory invalid');
  const docs = data.filter(row => row.document?.fields);
  if (docs.length >= 501) throw new Error('Job inventory needs review');
  return docs.map(row => ({ ...decodeFirestoreFields(row.document.fields), id: String(row.document.name).split('/').pop() }));
}

async function openOpportunities(env, contactId) {
  const locationId = env.HIGHLEVEL_LOCATION_ID || env.GHL_LOCATION_ID;
  const params = new URLSearchParams({ locationId, contactId, status: 'open', limit: '100', page: '1' });
  const data = await highlevel(env, `/opportunities/search?${params}`);
  if (!Array.isArray(data.opportunities) || data.opportunities.length >= 100 || Number(data.meta?.total || 0) > data.opportunities.length) throw new Error('Opportunity inventory incomplete');
  if (data.opportunities.some(row => (row.contactId || row.contact?.id) !== contactId)) throw new Error('Opportunity contact mismatch');
  return data.opportunities;
}

async function state(env, jobId) {
  const response = await firestoreFetch(env, `${DB}/sales_handoffs/${encodeURIComponent(jobId)}`);
  if (response.status === 404) return { value: {}, version: '' };
  if (!response.ok) throw new Error('Handoff status unavailable');
  const doc = await response.json();
  if (!doc.updateTime) throw new Error('Handoff version unavailable');
  return { value: decodeFirestoreFields(doc.fields), version: doc.updateTime };
}

async function saveState(env, jobId, value, version) {
  const url = new URL(`${DB}/sales_handoffs/${encodeURIComponent(jobId)}`);
  url.searchParams.set(version ? 'currentDocument.updateTime' : 'currentDocument.exists', version || 'false');
  const response = await firestoreFetch(env, url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: encodeFirestoreFields(value) }) });
  if (!response.ok) throw new Error('Handoff changed');
}

async function mirror(env, jobId, value) {
  try { const latest = await readJob(env, jobId); if (latest?.__updateTime) await patchJob(env, jobId, { salesFollowupExit: { ...value, jobId } }, latest.__updateTime); } catch { /* The server-only ledger remains authoritative. */ }
}

// Signals only the two no-message GHL exit helpers. Caller payloads cannot choose
// the contact, service, or outcome. DND/notify=false must not prevent a sales exit.
export async function syncSalesFollowupExit(env, jobId) {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(String(jobId || ''))) return { status: 'needs_job' };
  if (!firebaseServiceAccountConfigured(env) || !(env.HIGHLEVEL_API_KEY || env.GHL_API_KEY) || !(env.HIGHLEVEL_LOCATION_ID || env.GHL_LOCATION_ID)) return { status: 'not_configured' };
  let claimed = false, claimAttempted = false;
  try {
    const ledger = await state(env, jobId);
    const job = await readJob(env, jobId), milestone = salesExitMilestone(job), service = salesExitService(job);
    const stop = async reason => { const value = { status: 'needs_review', reason, checkedAt: new Date().toISOString() }; await mirror(env, jobId, value); return value; };
    if (!job || !milestone) return { status: 'not_eligible' };
    const revision = [job.estimate?.revision ?? 0, Number(job.estimate?.amount || job.total || job.priceQuoted || 0)].join(':');
    if (['sending', 'uncertain'].includes(ledger.value.status) || (ledger.value.status === 'signalled' && ledger.value.revision === revision)) return ledger.value;
    if (!service) return stop('service_not_identified');
    const contactId = String(job.highlevelContactId || '');
    if (!contactId) return stop('contact_not_linked');
    const linkedId = String(job.highlevelOpportunityId || '');
    if (!linkedId) return stop('opportunity_not_linked');
    const data = await highlevel(env, `/contacts/${encodeURIComponent(contactId)}`), contact = data.contact;
    if (!contact || contact.id !== contactId || contact.locationId !== (env.HIGHLEVEL_LOCATION_ID || env.GHL_LOCATION_ID) ||
      !((phone(job.phone) && phone(job.phone) === phone(contact.phone)) || (email(job.email) && email(job.email) === email(contact.email)))) return stop('contact_mismatch');
    if (contact.tags?.includes(`egc-${service}-sales-exit`)) return stop('exit_already_pending');
    if (milestone === 'booked') {
      const data = await highlevel(env, `/calendars/events/appointments/${encodeURIComponent(job.highlevelAppointmentId)}`), event = data.appointment || data.event || data;
      const calendarId = customerCalendars(env).jobCalendarId;
      const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(event.startTime));
      const part = kind => local.find(item => item.type === kind)?.value || '';
      if (!calendarId || calendarId === EMPLOYEE_CALENDAR || event.calendarId !== calendarId || event.contactId !== contactId ||
        !['confirmed', 'showed', 'completed'].includes(String(event.appointmentStatus || event.status || '').toLowerCase()) ||
        `${part('year')}-${part('month')}-${part('day')}` !== job.date || `${part('hour')}:${part('minute')}` !== job.time) return stop('service_booking_not_verified');
    }
    const jobs = await allJobs(env);
    if (!jobs.some(row => row.id === jobId)) return stop('job_inventory_incomplete');
    if (jobs.some(row => row.id !== jobId && row.id !== job.sourceWalkthroughId && !row.recordType && !String(row.id).startsWith('secure_') && sameCustomer(row, job) && !inactive(row))) return stop('another_customer_job_active');
    const linkedData = await highlevel(env, `/opportunities/${encodeURIComponent(linkedId)}`), linked = linkedData.opportunity || linkedData;
    const pipelineId = env.HIGHLEVEL_PIPELINE_ID || env.GHL_PIPELINE_ID || 'anSgrMpYHtAX6YlUHnIR';
    if (linked.id !== linkedId || (linked.contactId || linked.contact?.id) !== contactId || linked.pipelineId !== pipelineId) return stop('opportunity_mismatch');
    const opportunities = await openOpportunities(env, contactId);
    if (opportunities.length > 1 || (linkedId && opportunities.some(row => row.id !== linkedId))) return stop('another_opportunity_active');
    const latest = await readJob(env, jobId);
    if (!latest?.__updateTime || latest.__updateTime !== job.__updateTime) return { status: 'retry', reason: 'job_changed' };
    const tag = `egc-${service}-sales-exit`, value = { status: 'sending', jobId, contactId, service, milestone, revision, tag, attemptedAt: new Date().toISOString() };
    claimAttempted = true; await saveState(env, jobId, value, ledger.version); claimed = true;
    await highlevel(env, `/contacts/${encodeURIComponent(contactId)}/tags`, { method: 'POST', body: JSON.stringify({ tags: [tag] }) });
    const current = await state(env, jobId), result = { ...value, status: 'signalled', signalledAt: new Date().toISOString() };
    await saveState(env, jobId, result, current.version); await mirror(env, jobId, result);
    return result;
  } catch (error) {
    if (claimAttempted && !claimed) {
      try { const latest = await state(env, jobId); if (['sending', 'signalled', 'uncertain'].includes(latest.value.status)) return latest.value; } catch {}
    }
    const rejected = claimed && error.status >= 400 && error.status < 500 && error.status !== 408;
    const result = { status: claimed ? (rejected ? 'failed' : 'uncertain') : 'needs_review', reason: rejected ? 'handoff_rejected' : claimed ? 'handoff_result_unknown' : 'verification_unavailable', checkedAt: new Date().toISOString() };
    if (claimed) { try { const latest = await state(env, jobId); await saveState(env, jobId, { ...latest.value, ...result }, latest.version); } catch {} }
    await mirror(env, jobId, result);
    return result;
  }
}
