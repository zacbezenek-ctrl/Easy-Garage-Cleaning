/**
 * EGC ↔ HighLevel bridge — Cloudflare Pages Function.
 *
 * GET  /api/highlevel?view=command       Pipeline, stages and open opportunities
 * GET  /api/highlevel?view=walkthroughs  Calendar events for the requested day
 * GET  /api/highlevel?view=contacts&q=   Contact lookup for crew tools
 * POST /api/highlevel                    Save a completed Game Plan as a pinned
 *                                        HighLevel contact note.
 *
 * Required Cloudflare secrets:
 *   HIGHLEVEL_API_KEY (or GHL_API_KEY)
 *   HIGHLEVEL_LOCATION_ID (or GHL_LOCATION_ID)
 * Optional:
 *   HIGHLEVEL_WALKTHROUGH_CALENDAR_ID
 *   HIGHLEVEL_JOB_CALENDAR_ID
 *   HIGHLEVEL_PIPELINE_ID
 *   HIGHLEVEL_PIPELINE_STAGE_SCHEDULED_ID
 *   HIGHLEVEL_PIPELINE_STAGE_WALKTHROUGH_COMPLETE_ID
 *   HIGHLEVEL_PIPELINE_STAGE_JOB_COMPLETE_ID
 *   HIGHLEVEL_USER_ID
 *   HIGHLEVEL_LEADS_RESET_AT
 */

import { savedHandoffPayload } from '../_lib/walkthrough-handoff.js';
import { requireDispatcher } from '../_lib/dispatch-service.js';
import { getHubSession, hasBusinessAccess } from '../_lib/hub-session.js';
import { sendAcceptedQuotePortal } from '../_lib/portal-invitation.js';
import { syncSalesFollowupExit, salesExitMilestone } from '../_lib/sales-followup-exit.js';
import { readJob, patchJob } from '../_lib/firestore-job.js';
import { isStaffScheduledCalendar } from '../_lib/highlevel-calendars.js';
import { createJobAssignmentAccess } from '../_lib/job-assignment.js';
import { syncNativeSchedule } from '../_lib/operations-schedule-sync.js';
import { syncNativeNote } from '../_lib/operations-note-sync.js';
import { operationsEnabled } from '../_lib/operations-service-auth.js';
import { ensureHighLevelCheckin } from '../_lib/highlevel-checkin.js';
import { addTags, completeAppointment, ensureContact, ghl, highLevelConfig } from '../_lib/highlevel-tags.js';
import { ghlTagOutboxEnabled, handOffScheduleTags, scheduleTagOwner } from '../_lib/ghl-tag-outbox.js';
import { can } from '../_lib/staff-roles.js';
import { leadDetailsFromNotes } from '../_lib/booking-slots.js';

const DEFAULT_LEAD_RESET_AT = '2026-09-03T21:51:19.314Z';
const HOST = /^(?:easygaragecleaning\.com|www\.easygaragecleaning\.com|easy-garage-cleaning\.pages\.dev|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?)$/;

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  }});
}

function allowed(request) {
  const raw = request.headers.get('Origin') || request.headers.get('Referer');
  if (!raw) return true;
  try { return HOST.test(new URL(raw).host); } catch { return false; }
}

function config(env) {
  return {
    ...highLevelConfig(env),
    quoteReadyTags: String(env.HIGHLEVEL_QUOTE_READY_TAGS || env.GHL_QUOTE_READY_TAGS || 'egc-quote-ready,gc-quote-open').split(',').map(x => x.trim()).filter(Boolean),
  };
}

async function mayChangeJob(session, job, access) {
  if (hasBusinessAccess(session)) return true;
  return access.assigned(job);
}

// GHL-TRACK-1: once the sync has written the appointment and linked the contact, the outbox entry that owns the
// visit's scheduled tags gets its attempt (after the response when the runtime keeps it alive).
function handOffTags(env, waitUntil, plan) {
  if (!plan.entryId) return;
  const attempt = handOffScheduleTags(env, plan.entryId, { now: new Date().toISOString() }).catch(() => null);
  if (typeof waitUntil === 'function') waitUntil(attempt); else return attempt;
}

function contactShape(contact = {}) {
  const address = contact.address1 || contact.address || '';
  return {
    id: contact.id || '',
    name: contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(' '),
    phone: contact.phone || '',
    email: contact.email || '',
    address: [address, contact.city, contact.state].filter(Boolean).join(', '),
    source: contact.source || '',
    tags: Array.isArray(contact.tags) ? contact.tags : [],
  };
}

async function pipelines(c) {
  const data = await ghl(c, `/opportunities/pipelines?locationId=${encodeURIComponent(c.locationId)}`);
  return data.pipelines || [];
}

async function opportunities(c, query = '') {
  const params = new URLSearchParams({
    locationId: c.locationId,
    status: 'open',
    order: 'added_desc',
    limit: '100',
    page: '1',
    getCalendarEvents: 'true',
  });
  if (query) params.set('q', query.slice(0, 75));
  if (c.pipelineId) params.set('pipelineId', c.pipelineId);
  const data = await ghl(c, `/opportunities/search?${params}`);
  return data.opportunities || [];
}

function leadResetAt(env) {
  const configured = env.HIGHLEVEL_LEADS_RESET_AT || env.GHL_LEADS_RESET_AT || DEFAULT_LEAD_RESET_AT;
  return Number.isFinite(Date.parse(configured)) ? new Date(configured).toISOString() : DEFAULT_LEAD_RESET_AT;
}

function opportunitiesSince(rows, cutoff) {
  const after = Date.parse(cutoff);
  return (rows || []).filter(row => {
    const created = Date.parse(row && row.createdAt || '');
    return Number.isFinite(created) && created >= after;
  });
}

async function contacts(c, query) {
  const params = new URLSearchParams({ locationId: c.locationId, query: query.slice(0, 75), limit: '20' });
  try {
    const data = await ghl(c, `/contacts/?${params}`, { headers: { Version: '2021-07-28' } });
    return (data.contacts || []).map(contactShape);
  } catch {
    // Private integrations without broad contact-search access can still search
    // the contacts embedded in opportunities.
    const rows = await opportunities(c, query), seen = new Set(), result = [];
    for (const row of rows) {
      const contact = contactShape(row.contact || { id: row.contactId });
      if (contact.id && !seen.has(contact.id)) { seen.add(contact.id); result.push(contact); }
    }
    return result;
  }
}

async function contactById(c, id) {
  if (!id) return {};
  const data = await ghl(c, `/contacts/${encodeURIComponent(id)}`);
  return data.contact || {};
}

async function calendarList(c) {
  const data = await ghl(c, `/calendars/?locationId=${encodeURIComponent(c.locationId)}&showDrafted=false`);
  return data.calendars || [];
}

async function findCalendar(c, type = 'walkthrough') {
  const configured = type === 'job' ? c.jobCalendarId : c.walkthroughCalendarId;
  if (configured === '2yYX63nHYvUsL6KKhAc0') throw new Error('The Employee hiring calendar cannot be used for customer appointments');
  if (configured) return configured;
  return '';
}

function localBounds(day) {
  const safe = /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? day : new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  // Calendar filtering is broad by one day to survive DST/offset changes; the
  // browser performs the final America/Denver day filter.
  const noon = Date.parse(`${safe}T12:00:00-06:00`);
  return { day: safe, start: noon - 36 * 3600000, end: noon + 36 * 3600000 };
}

async function getWalkthroughs(c, day) {
  const calendarId = await findCalendar(c, 'walkthrough');
  if (!calendarId) return { calendarId: '', events: [] };
  const bounds = localBounds(day);
  const params = new URLSearchParams({ locationId: c.locationId, calendarId,
    startTime: String(bounds.start), endTime: String(bounds.end) });
  const data = await ghl(c, `/calendars/events?${params}`);
  const raw = data.events || [];
  const events = await Promise.all(raw.slice(0, 40).map(async event => {
    let contact = event.contact || {};
    if (!contact.id && event.contactId) {
      try { contact = await contactById(c, event.contactId); } catch { contact = { id: event.contactId }; }
    }
    return {
      ...contactShape(contact),
      id: event.id || '', contactId: event.contactId || contact.id || '',
      title: event.title || 'Walkthrough', startTime: event.startTime || '', endTime: event.endTime || '',
      status: event.appointmentStatus || event.status || 'scheduled',
      address: event.address || contact.address1 || '',
    };
  }));
  return { calendarId, events };
}

function rangeBounds(start, end) {
  const startMs = Date.parse(start || '');
  const endMs = Date.parse(end || '');
  const now = Date.now();
  return {
    start: Number.isFinite(startMs) ? startMs : now - 86400000,
    end: Number.isFinite(endMs) ? endMs : now + 14 * 86400000,
  };
}

async function getSchedule(c, start, end) {
  const list = await calendarList(c);
  const configured = [c.walkthroughCalendarId, c.jobCalendarId].filter(Boolean);
  const ids = configured.length ? [...new Set(configured)] : list.map(x => x.id).filter(Boolean);
  const bounds = rangeBounds(start, end);
  const batches = await Promise.all(ids.slice(0, 12).map(async calendarId => {
    const params = new URLSearchParams({ locationId: c.locationId, calendarId,
      startTime: String(bounds.start), endTime: String(bounds.end) });
    try {
      const data = await ghl(c, `/calendars/events?${params}`);
      return (data.events || []).map(event => ({ ...event, calendarId }));
    } catch { return []; }
  }));
  const seen = new Set();
  const events = batches.flat().filter(event => event.id && !seen.has(event.id) && seen.add(event.id)).map(event => ({
    id: event.id,
    contactId: event.contactId || event.contact?.id || '',
    calendarId: event.calendarId,
    title: event.title || 'Scheduled event',
    name: event.contact?.name || '',
    phone: event.contact?.phone || '',
    email: event.contact?.email || '',
    address: event.address || event.contact?.address1 || '',
    startTime: event.startTime || '',
    endTime: event.endTime || '',
    status: event.appointmentStatus || event.status || 'scheduled',
    source: 'highlevel',
  }));
  return { events, calendars: list.map(x => ({ id: x.id, name: x.name || 'Calendar' })) };
}

function opportunityForContact(rows, contactId, pipelineId) {
  return (rows || []).find(row => {
    const rowContact = row.contactId || row.contact?.id || '';
    return rowContact === contactId && (!pipelineId || row.pipelineId === pipelineId);
  }) || null;
}

function opportunityInput(payload = {}, client = {}) {
  const rawValue = payload.monetary_value ?? payload.quote?.total ?? payload.job?.locked_total ?? payload.job?.quoted_rate ?? client.total ?? client.priceQuoted;
  return {
    name: payload.opportunity_name || payload.quote?.title || client.name || client.customer || payload.title || 'EGC Garage Service',
    monetaryValue: rawValue === undefined || rawValue === '' ? undefined : Number(rawValue),
    idempotencyKey: payload.idempotency_key || '',
  };
}

async function advanceOpportunity(c, contactId, stageId, fallbackTag, opportunityId = '', details = {}) {
  if (!stageId) return { updated: false, reason: 'stage-not-configured', fallbackTag };
  if (!c.pipelineId) return { updated: false, reason: 'pipeline-not-configured', fallbackTag };
  try {
    if (!opportunityId) {
      const params = new URLSearchParams({ locationId: c.locationId, contactId, status: 'open', limit: '100', page: '1' });
      const found = await ghl(c, `/opportunities/search?${params}`);
      if (!Array.isArray(found.opportunities) || found.opportunities.length || Number(found.meta?.total || 0)) return { updated: false, reason: 'existing-opportunity-needs-link', fallbackTag };
      const amount = Number(details.monetaryValue);
      const created = await ghl(c, '/opportunities/upsert', { method: 'POST', headers: { 'Idempotency-Key': details.idempotencyKey || `opportunity:${contactId}:${c.pipelineId}` }, body: JSON.stringify({
        pipelineId: c.pipelineId, locationId: c.locationId, name: details.name || 'EGC Garage Service', pipelineStageId: stageId,
        status: 'open', contactId, monetaryValue: Number.isFinite(amount) ? amount : 0, assignedTo: c.userId || undefined,
        followers: c.userId ? [c.userId] : [], isRemoveAllFollowers: false, followersActionType: 'add',
      }) });
      const createdId = created.opportunity?.id || created.id || '';
      return { updated: Boolean(createdId), created: Boolean(createdId), opportunityId: createdId, pipelineStageId: stageId, fallbackTag };
    }
    const data = await ghl(c, `/opportunities/${encodeURIComponent(opportunityId)}`);
    const opportunity = data.opportunity || data;
    if (opportunity.id !== opportunityId || (opportunity.contactId || opportunity.contact?.id) !== contactId || opportunity.pipelineId !== c.pipelineId) return { updated: false, reason: 'opportunity-contact-mismatch', fallbackTag };
    const id = opportunityId || opportunity?.id || '';
    const pipelineId = opportunity?.pipelineId || c.pipelineId;
    const name = opportunity?.name || opportunity?.contact?.name || details.name || 'EGC Garage Service';
    const suppliedValue = Number(details.monetaryValue);
    const monetaryValue = details.monetaryValue !== undefined && Number.isFinite(suppliedValue)
      ? suppliedValue : Number(opportunity?.monetaryValue || 0);
    await ghl(c, `/opportunities/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({
        pipelineId,
        name,
        pipelineStageId: stageId,
        status: opportunity?.status || 'open',
        monetaryValue,
      }),
    });
    return { updated: true, opportunityId: id, pipelineStageId: stageId, fallbackTag };
  } catch (error) {
    return { updated: false, reason: 'update-failed', detail: error.detail || error.message, fallbackTag };
  }
}

async function createAppointment(c, payload, contactId) {
  if(c.operationsEnv&&operationsEnabled(c.operationsEnv))return syncNativeSchedule(c.operationsEnv,c.operationsSession,{portalVisitId:payload.job_id,requestId:payload.idempotency_key,contactProviderId:contactId,runAutomations:payload.notify!==false});
  const type = payload.event_type === 'job' ? 'job' : 'walkthrough';
  const calendarId = payload.calendar_id || await findCalendar(c, type);
  if (calendarId === '2yYX63nHYvUsL6KKhAc0') throw new Error('The Employee hiring calendar cannot be used for customer appointments');
  if (!calendarId) throw new Error('No HighLevel calendar is available');
  const body = {
    calendarId,
    startTime: payload.start_time, endTime: payload.end_time,
    title: payload.title || (type === 'job' ? 'EGC Garage Service' : 'EGC Free Walkthrough'),
    appointmentStatus: payload.status || 'confirmed', assignedUserId: payload.assigned_user_id || c.userId || undefined,
    description: payload.notes || '', address: payload.address || payload.client?.address || '',
    toNotify: payload.notify !== false,
    ...(isStaffScheduledCalendar(calendarId) ? { ignoreFreeSlotValidation: true } : {}),
  };
  if (payload.appointment_id) {
    const appointment = await ghl(c, `/calendars/events/appointments/${encodeURIComponent(payload.appointment_id)}`, { method: 'PUT', headers: payload.idempotency_key ? { 'Idempotency-Key': payload.idempotency_key } : {}, body: JSON.stringify(body) });
    return { appointmentId: appointment.id || appointment.event?.id || payload.appointment_id, calendarId, updated: true };
  }
  try {
    const startMs = Date.parse(payload.start_time), endMs = Date.parse(payload.end_time);
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      const params = new URLSearchParams({ locationId: c.locationId, calendarId,
        startTime: String(startMs - 300000), endTime: String(endMs + 300000) });
      const found = await ghl(c, `/calendars/events?${params}`);
      const existing = (found.events || []).find(event => {
        const eventContactId = event.contactId || event.contact?.id || '';
        const status = String(event.appointmentStatus || event.status || '').toLowerCase();
        return eventContactId === contactId && !['cancelled', 'canceled'].includes(status) &&
          Date.parse(event.startTime) === startMs && Date.parse(event.endTime) === endMs;
      });
      if (existing?.id) return { appointmentId: existing.id, calendarId, updated: false, reused: true };
    }
  } catch {}
  const appointment = await ghl(c, '/calendars/events/appointments', { method: 'POST', headers: payload.idempotency_key ? { 'Idempotency-Key': payload.idempotency_key } : {}, body: JSON.stringify({ ...body, locationId: c.locationId, contactId }) });
  return { appointmentId: appointment.id || appointment.event?.id || appointment.appointment?.id || '', calendarId, updated: false };
}

function finishSummary(value) {
  const labels = { pressure_wash: 'One-car garage pressure wash', deep_clean: 'Deep clean', mouse_trapping: 'Non-toxic mouse trapping' };
  return (Array.isArray(value) ? value : [value]).filter(Boolean).map(item => labels[item] || item).join(', ') || '—';
}

// Itemized signed quotes list their sold lines; a legacy single-line quote
// keeps today's note unchanged.
function quoteLines(quote) {
  const lines = quote?.itemized === true && Array.isArray(quote.line_items) ? quote.line_items : [];
  const amount = value => `${Number(value) < 0 ? '-' : ''}$${Math.abs(Number(value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return lines.length ? ['Itemized quote:', ...lines.slice(0, 40).map(line => `- ${String(line?.name || 'Line item').slice(0, 160)}${Number(line?.qty) !== 1 ? ` × ${Number(line?.qty)}` : ''}: ${amount(line?.total)}`)] : [];
}

// A signed handoff's Job Brief is written once from the signed quote and replayed unchanged after Dispatch moves the
// job, so its date line names the signed schedule rather than reading as the current plan. The label depends only on
// the brief, never on the job's current schedule, so every replay sends the same body.
function noteBody(payload, { signed = false } = {}) {
  const p = payload || {}, q = p.quote || {}, d = p.discovery || {}, s = p.scope || {}, l = p.logistics || {};
  const list = value => Array.isArray(value) ? value.filter(Boolean).join(', ') : (value || '—');
  const finish = s.finish_details || {};
  const current = signed ? '; the current time is on the appointment' : '';
  if (p.internal_notes) return [
    'EGC INTERNAL JOB BRIEF',
    `Completed: ${p.sent_at || p.completed_at || new Date().toISOString()}`,
    `Locked total: $${Number(q.total || 0).toLocaleString('en-US')}`,
    `Deposit: $${Number(q.deposit || 0).toLocaleString('en-US')}`,
    `${signed ? 'Signed date' : 'Target date'}: ${q.job_date || 'TBD'} · ${q.start_time || 'TBD'}–${q.end_time || 'TBD'}${current}`,
    ...quoteLines(q),
    '',
    String(p.internal_notes).replace(/^EGC INTERNAL JOB BRIEF\s*/i, '').trim(),
  ].join('\n').slice(0, 4900);
  const lines = [
    'EGC WALKTHROUGH PLAN',
    `Completed: ${p.sent_at || p.completed_at || new Date().toISOString()}`,
    '',
    `Locked total: $${Number(q.total || 0).toLocaleString('en-US')}`,
    `Deposit: $${Number(q.deposit || 0).toLocaleString('en-US')}`,
    ...quoteLines(q),
    `${signed ? 'Signed date' : 'Target date'}: ${q.job_date || 'TBD'}${current}`,
    `${signed ? 'Signed arrival window' : 'Arrival window'}: ${q.start_time || 'TBD'}–${q.end_time || 'TBD'}`,
    `Assigned crew: ${l.assigned_to || 'Unassigned'}${l.crew_size ? ` (${l.crew_size} needed)` : ''}`,
    `Why now: ${d.why_now || '—'}`,
    `Success looks like: ${d.success || '—'}`,
    `Decision maker: ${d.decision_maker || '—'}`,
    `Scope: ${s.loads || 0} truckload(s); ${s.garages || 1} garage(s); fullness ${s.fullness || 'not recorded'}`,
    `Sort method: ${s.sort_method || '—'}`,
    `KEEP: ${s.keep_items || '—'}`,
    `REMOVE: ${s.remove_items || '—'}`,
    `Keep / remove plan: ${s.keep_remove || s.sort_method || 'See signed Game Plan'}`,
    `Exclusions: ${s.exclusions || 'None recorded'}`,
    `Hazards: ${list(s.hazards)}`,
    `Access: ${list(s.access)}`,
    `Access notes: ${l.notes || '—'}`,
    `Truck placement: ${l.truck_placement || s.truck_placement || '—'}`,
    `Special handling: ${list(s.special_items)}`,
    `Finish: ${finishSummary(s.finish)}`,
    `Materials: ${finish.shelf_qty || 0} ${finish.shelf_type || ''} shelf unit(s); ${finish.tote_qty || 0} tote(s)`,
    `Before photos captured: ${Number(p.photos?.before || 0)}`,
    `Scope accepted by: ${p.acceptance?.accepted_by || '—'} at ${p.acceptance?.accepted_at || '—'}`,
    '',
    `Customer / crew notes: ${p.notes || 'None recorded'}`,
  ];
  return lines.filter((x, i) => x || lines[i - 1]).join('\n').slice(0, 4900);
}

function appointmentInstructions(payload) {
  const p = payload || {}, d = p.discovery || {}, s = p.scope || {}, l = p.logistics || {};
  if (p.internal_notes) return String(p.internal_notes).slice(0, 3000);
  const list = value => Array.isArray(value) ? value.filter(Boolean).join(', ') : (value || '—');
  return [
    `CUSTOMER GOAL: ${d.success || '—'}`,
    `WHY NOW: ${d.why_now || '—'}`,
    `KEEP: ${s.keep_items || '—'}`,
    `REMOVE: ${s.remove_items || '—'}`,
    `DO NOT MOVE / EXCLUSIONS: ${s.exclusions || 'None recorded'}`,
    `HAZARDS: ${list(s.hazards)}`,
    `ACCESS: ${list(s.access)}${l.notes ? ` — ${l.notes}` : ''}`,
    `TRUCK: ${l.truck_placement || s.truck_placement || '—'}`,
    `SPECIAL HANDLING: ${list(s.special_items)}`,
    `FINISH: ${finishSummary(s.finish)}`,
    `CUSTOMER NOTES: ${p.notes || 'None recorded'}`,
  ].join('\n').slice(0, 3000);
}

function closeoutNote(payload) {
  const job = payload.job || {};
  const clientChecks = Array.isArray(payload.client_checklist) ? payload.client_checklist : [];
  return [
    'EGC JOB CLOSEOUT',
    `Completed: ${payload.sent_at || new Date().toISOString()}`,
    `Customer: ${job.customer || '—'}`,
    `Locked total: $${Number(job.locked_total || job.quoted_rate || 0).toLocaleString('en-US')}`,
    `Walkthrough load plan: ${job.quoted_loads === 0 || job.quoted_loads ? job.quoted_loads : '—'}`,
    `Actual truckloads: ${job.actual_loads === 0 || job.actual_loads ? job.actual_loads : '—'}`,
    `Load variance: ${Number.isFinite(Number(job.actual_loads)) && Number.isFinite(Number(job.quoted_loads)) ? Number(job.actual_loads) - Number(job.quoted_loads) : '—'}`,
    `Hours on site: ${job.hours_on_site || '—'}`,
    `Dump fees: $${Number(job.dump_fees || 0).toLocaleString('en-US')}`,
    `Payment received now: $${Number(payload.payment && payload.payment.amount_received || 0).toLocaleString('en-US')}`,
    `Paid to date: $${Number(payload.payment && payload.payment.paid_to_date || 0).toLocaleString('en-US')}`,
    `Balance remaining: $${Number(payload.payment && payload.payment.balance || 0).toLocaleString('en-US')}`,
    `Payment method / reference: ${payload.payment && payload.payment.method || 'unpaid'} · ${payload.payment && payload.payment.reference || '—'}`,
    `Garage Guard: ${payload.garage_guard || 'not recorded'}`,
    `After photos: ${payload.photos && payload.photos.after || 0}`,
    `Drive folder: ${payload.drive_folder || '—'}`,
    `Original customer goal: ${job.customer_goal || '—'}`,
    `Original walkthrough notes: ${job.original_customer_notes || '—'}`,
    `Pre-job handoff: ${job.pre_job_completed_at ? `Completed ${job.pre_job_completed_at}` : job.pre_job_exception ? `Exception — ${job.pre_job_exception}` : 'No completion record'}`,
    ...(clientChecks.length ? ['', 'CLIENT PROMISE CHECKS', ...clientChecks.map(item => `✓ ${item.label}${item.detail ? ` — ${item.detail}` : ''}`)] : []),
    '',
    `Crew closeout notes: ${job.notes || 'None recorded'}`,
  ].join('\n').slice(0, 4900);
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  }});
}

// SALES-BOOKING: with EGC_STAFF_ROLE_ACCESS a schedule.book holder (Sales, Phone) reads the lead feed, the
// contact search and one lead's details, to call and book leads. Every other view stays business-only, and
// with the flag off can() never grants schedule.book.
const BOOKER_VIEWS = new Set(['command', 'contacts', 'lead']);
const CONTACT_ID = /^[A-Za-z0-9_-]{1,180}$/;
// A booker's lead feed: who to call and where the lead stands, never the opportunity's value.
const bookerOpportunity = row => ({ id: row.id, name: row.name, status: row.status, source: row.source, pipelineId: row.pipelineId, pipelineStageId: row.pipelineStageId, createdAt: row.createdAt,
  contactId: row.contactId || row.contact?.id || '', contact: { id: row.contact?.id || row.contactId || '', name: row.contact?.name || '', phone: row.contact?.phone || '', email: row.contact?.email || '' } });
// A booker's contact search: who the contact is and where, never its tags or source (money and pipeline status).
const bookerContact = row => ({ id: row.id, name: row.name, phone: row.phone, email: row.email, address: row.address });

// One lead for the Hub's Book walkthrough: the contact and what its website-lead note asked for (read only).
// A note that cannot be read leaves the lead without its requested window.
async function leadView(c, id) {
  if (!CONTACT_ID.test(id)) return reply(400, { ok: false, error: 'Choose a HighLevel contact.' });
  const [contact, notes] = await Promise.allSettled([contactById(c, id), ghl(c, `/contacts/${encodeURIComponent(id)}/notes`)]);
  if (contact.status === 'rejected') {
    if (contact.reason?.status === 404) return reply(404, { ok: false, error: 'This HighLevel contact was not found.' });
    throw contact.reason;
  }
  const found = contact.value || {};
  if (found.id !== id || found.locationId !== c.locationId) return reply(404, { ok: false, error: 'This HighLevel contact was not found.' });
  const shape = contactShape(found), details = notes.status === 'fulfilled' ? leadDetailsFromNotes(notes.value?.notes) : null;
  return reply(200, { ok: true, locationId: c.locationId, notesRead: notes.status === 'fulfilled', lead: {
    contactId: shape.id, name: shape.name, phone: shape.phone, email: shape.email || details?.email || '', address: shape.address,
    service: details?.service || '', requestedSlot: details?.requestedSlot || null, requestedSlotText: details?.requestedSlotText || '',
  } });
}

export async function onRequestGet({ request, env }) {
  if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
  const session = await getHubSession(request, env);
  if (!session) return reply(401, { ok: false, code: 'HUB_AUTH_REQUIRED', error: 'Sign in to the EGC Hub' });
  const url = new URL(request.url), view = url.searchParams.get('view') || 'command';
  if (!hasBusinessAccess(session) && !(BOOKER_VIEWS.has(view) && can(session, 'schedule.book', env))) return reply(403, { ok: false, code: 'BUSINESS_ACCESS_REQUIRED', error: 'Business access is required for CRM records and handoffs. Open the assigned field job for crew actions.' });
  const c = config(env);
  if (!c.token || !c.locationId) return reply(501, { ok: false, code: 'HIGHLEVEL_NOT_CONFIGURED', error: 'HighLevel needs an API key and location ID' });
  if (view === 'walkthroughs' && !hasBusinessAccess(session)) return reply(403, { ok: false, code: 'BUSINESS_ACCESS_REQUIRED', error: 'Walkthrough access is limited to Zac, Tyler, and Alex' });
  try {
    if (view === 'lead') return await leadView(c, String(url.searchParams.get('contactId') || '').trim());
    if (view === 'contacts') {
      const q = String(url.searchParams.get('q') || '').trim();
      if (q.length < 2) return reply(400, { ok: false, error: 'Search needs at least 2 characters' });
      const found = await contacts(c, q);
      return reply(200, { ok: true, contacts: hasBusinessAccess(session) ? found : found.map(bookerContact) });
    }
    if (view === 'walkthroughs') {
      const result = await getWalkthroughs(c, url.searchParams.get('date') || '');
      return reply(200, { ok: true, ...result });
    }
    if (view === 'schedule') {
      const result = await getSchedule(c, url.searchParams.get('start') || '', url.searchParams.get('end') || '');
      return reply(200, { ok: true, ...result });
    }
    const [pipes, allOpps] = await Promise.all([pipelines(c), opportunities(c)]);
    const resetAt = leadResetAt(env), opps = opportunitiesSince(allOpps, resetAt);
    if (!hasBusinessAccess(session)) return reply(200, { ok: true, projection: 'booker', pipelines: pipes, opportunities: opps.map(bookerOpportunity), leadResetAt: resetAt, locationId: c.locationId });
    return reply(200, { ok: true, pipelines: pipes, opportunities: opps, leadResetAt: resetAt, locationId: c.locationId });
  } catch (error) {
    // Provider detail stays with business users; a booker learns only that HighLevel is unavailable.
    return reply(502, { ok: false, error: 'HighLevel is unreachable', ...(hasBusinessAccess(session) ? { detail: error.detail || error.message } : {}) });
  }
}

export async function onRequestPost({ request, env, waitUntil }) {
  if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
  const session = await getHubSession(request, env);
  if (!session) return reply(401, { ok: false, code: 'HUB_AUTH_REQUIRED', error: 'Sign in to the EGC Hub' });
  if (!hasBusinessAccess(session)) return reply(403, { ok: false, code: 'BUSINESS_ACCESS_REQUIRED', error: 'Business access is required for CRM records and handoffs. Open the assigned field job for crew actions.' });
  const assignments = createJobAssignmentAccess(env, session);
  const c = config(env);
  if (!c.token || !c.locationId) return reply(501, { ok: false, code: 'HIGHLEVEL_NOT_CONFIGURED', error: 'HighLevel needs an API key and location ID' });
  const raw = await request.text();
  if (raw.length > 256 * 1024) return reply(413, { ok: false, error: 'Payload too large' });
  let payload;
  try { payload = JSON.parse(raw); } catch { return reply(400, { ok: false, error: 'Invalid JSON' }); }
  payload.idempotency_key ||= request.headers.get('Idempotency-Key') || '';
  if (!['game_plan','post_job','schedule','lifecycle','sales_exit'].includes(payload.tool)) return reply(400, { ok: false, error: 'Unsupported HighLevel handoff' });
  if (payload.tool === 'lifecycle') {
    payload.event = String(payload.event || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (['garage-sales-exit', 'junk-sales-exit'].includes(payload.event)) return reply(400, { ok: false, error: 'Sales exits require a verified saved job' });
  }
  if (payload.tool === 'sales_exit') {
    if (!hasBusinessAccess(session)) return reply(403, { ok: false, error: 'Business access required' });
    return reply(200, { ok: true, salesFollowupExit: await syncSalesFollowupExit(env, payload.job_id) });
  }
  // New signed walkthroughs are synchronized from their persisted snapshot.
  // The browser supplies only the canonical job and original request identity.
  const handoffRequestId = payload.tool === 'game_plan' ? payload.handoff_request_id || '' : '';
  if (payload.tool === 'game_plan' && payload.job_id) {
    try {
      const saved = handoffRequestId ? await readJob(env, payload.job_id) : await readJob(env, payload.job_id).catch(()=>null);
      if (handoffRequestId || saved?.handoffVersion === 1) {
        requireDispatcher(session, env);
        if (!operationsEnabled(env)) return reply(503,{ok:false,code:'HANDOFF_NATIVE_SYNC_REQUIRED',error:'The signed job is saved. The native operations bridge must be available before CRM synchronization.'});
        if (!saved || saved.id !== payload.job_id) return reply(409,{ok:false,error:'The saved handoff job could not be verified.'});
        payload = savedHandoffPayload(saved, handoffRequestId);
      }
    } catch (error) { return reply(error.status || 503,{ok:false,code:error.code || 'HANDOFF_SNAPSHOT_UNAVAILABLE',error:'The signed handoff could not be verified. Open the saved Hub job before synchronizing.'}); }
  }
  const inviteRequested = payload.tool === 'game_plan' || (payload.tool === 'lifecycle' && payload.event === 'estimate-approved');
  if (inviteRequested && !hasBusinessAccess(session)) return reply(403, { ok: false, code: 'BUSINESS_ACCESS_REQUIRED', error: 'Business access required for quote approvals' });
  if (payload.job_id && !hasBusinessAccess(session)) {
    const savedJob = await readJob(env, payload.job_id).catch(() => null);
    if (!await mayChangeJob(session, savedJob, assignments)) return reply(403, { ok: false, error: 'This job is not assigned to you' });
  }
  if (payload.tool === 'game_plan' && !hasBusinessAccess(session)) return reply(403, { ok: false, code: 'BUSINESS_ACCESS_REQUIRED', error: 'Walkthrough access is limited to Zac, Tyler, and Alex' });
  if (payload.tool === 'schedule' && !hasBusinessAccess(session)) return reply(403, { ok: false, code: 'BUSINESS_ACCESS_REQUIRED', error: 'Schedule changes are limited to managers' });
  c.operationsEnv=env;c.operationsSession=session;
  if(operationsEnabled(env)&&['schedule','game_plan'].includes(payload.tool)&&!payload.job_id)return reply(409,{ok:false,code:'SCHEDULE_STABLE_IDENTITY_REQUIRED',error:'Save the exact Hub visit before synchronizing its provider appointment.'});
  // This runs independently of notes/calendar writes, and validates approval and
  // recipient from storage. Repeating the handoff cannot send another invitation.
  const portalInvitation = inviteRequested ? await sendAcceptedQuotePortal(env, payload.job_id, { requireRequested: true }) : undefined;
  const client = payload.client || payload.job || {};
  const exitForJob = async () => {
    if (!hasBusinessAccess(session)) {
      const current = payload.job_id ? await readJob(env, payload.job_id).catch(() => null) : null;
      if (!await mayChangeJob(session, current, assignments)) return { status: 'not_authorized' };
    }
    return syncSalesFollowupExit(env, payload.job_id);
  };
  const finish = async (contactId, result) => {
    let handoffSync = handoffRequestId ? {status:'pending',reason:'storage_readback_required'} : undefined;
    // Preserve durable links before evaluating the saved job. Never trust an
    // incoming contact ID as authority to stop that person's sales workflows.
    try {
      const job = payload.job_id ? await readJob(env, payload.job_id) : null;
      if (job?.__updateTime && await mayChangeJob(session, job, assignments) && (!job.highlevelContactId || job.highlevelContactId === contactId)) {
        const contact = await contactById(c, contactId);
        const digits = value => String(value || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
        const samePhone = digits(job.phone) && digits(job.phone) === digits(contact.phone);
        const sameEmail = job.email && String(job.email).trim().toLowerCase() === String(contact.email || '').trim().toLowerCase();
        if (contact.id === contactId && contact.locationId === c.locationId && (samePhone || sameEmail)) {
          const patch = { highlevelContactId: contactId };
          if (result.pipeline?.updated && result.pipeline.opportunityId) patch.highlevelOpportunityId = result.pipeline.opportunityId;
          if (result.appointmentId) patch.highlevelAppointmentId = result.appointmentId;
          if (handoffRequestId) {
            savedHandoffPayload(job,handoffRequestId);
            const verified=operationsEnabled(env)&&result.providerSync==='verified'&&Boolean(result.noteId);
            Object.assign(patch,{handoffSyncStatus:verified?'synced':'pending',handoffSyncError:verified?'':'provider_evidence_incomplete',handoffLastSyncAt:new Date().toISOString(),handoffNoteId:result.noteId || '',pipelineSync:result.pipeline || {}});
          }
          await patchJob(env, payload.job_id, patch, job.__updateTime);
          if (handoffRequestId) {
            const live=await readJob(env,payload.job_id);
            if(!live||live.handoffRequestId!==handoffRequestId||live.highlevelContactId!==contactId||result.appointmentId&&live.highlevelAppointmentId!==result.appointmentId)throw new Error('handoff_link_readback_failed');
            handoffSync={status:live.handoffSyncStatus || 'pending',noteId:live.handoffNoteId || '',pipeline:result.pipeline || {}};
          }
        }
      }
    } catch { /* Missing/ambiguous storage is handled by the verification below. */ }
    if(handoffRequestId&&handoffSync.reason==='storage_readback_required')return reply(503,{ok:false,code:'HANDOFF_STORAGE_READBACK_PENDING',error:'The Hub job is saved. CRM results need exact storage read-back before retrying.',portalInvitation,handoffSync});
    return reply(200, { ...result, ...(handoffSync?{handoffSync}:{}), salesFollowupExit: await exitForJob() });
  };
  try {
    const contactId = await ensureContact(c, { ...client, highlevel_contact_id: client.highlevel_contact_id || payload.highlevel_contact_id }, payload.tool === 'schedule' ? 'EGC Hub schedule' : payload.tool === 'lifecycle' ? 'EGC Hub lifecycle' : 'EGC walkthrough');
    if (!contactId) return reply(502, { ok: false, error: 'HighLevel did not return a contact ID' });
    if (payload.tool === 'schedule') {
      if (!payload.start_time || !payload.end_time) return reply(400, { ok: false, error: 'Schedule start and end are required' });
      // EGC_GHL_TAG_OUTBOX (GHL-TRACK-1): the saved visit is read first, so a cancelled or no-show visit's appointment is
      // written with that status and toNotify false, as the outbox writes it (never re-confirmed, never created), and a
      // visit whose tag outbox entry is current leaves its scheduled tags to the outbox. Off: the requests are exactly as before.
      const outbox = ghlTagOutboxEnabled(env), saved = outbox && payload.job_id ? await readJob(env, payload.job_id).catch(() => null) : null;
      const closed = outbox ? { cancelled: 'cancelled', canceled: 'cancelled', noshow: 'noshow', no_show: 'noshow', 'no-show': 'noshow' }[String(saved?.pipelineStatus || saved?.status || '').toLowerCase()] || '' : '';
      const event = closed && !payload.appointment_id && !operationsEnabled(env) ? { updated: false, reason: 'visit-closed' } : await createAppointment(c, closed ? { ...payload, status: closed, notify: false } : payload, contactId);
      if (payload.silent_update) return reply(200, { ok: true, contactId, ...event, pipeline: { updated: false, reason: 'silent-appointment-update' }, automation: { silent: true, notificationsRequested: false } });
      // Notify customer (payload.notify) governs the appointment's own automations and the reminder tag only; the
      // scheduled tags and the Scheduled stage follow every scheduled visit. A cancelled visit (read from storage, never
      // the browser) is synced as its cancellation alone: no scheduled or reminder tag, and no move to Scheduled.
      const stored = outbox ? saved : payload.job_id ? await readJob(env, payload.job_id).catch(() => null) : null;
      if (['cancelled', 'canceled'].includes(String(stored?.pipelineStatus || stored?.status || '').toLowerCase())) return finish(contactId, { ok: true, contactId, ...event, pipeline: { updated: false, reason: 'visit-cancelled' }, automation: { trigger: '', reminderTrigger: '', cancelled: true, notificationsRequested: payload.notify !== false } });
      if (closed === 'noshow') return finish(contactId, { ok: true, contactId, ...event, pipeline: { updated: false, reason: 'visit-no-show' }, automation: { trigger: '', reminderTrigger: '', noShow: true, notificationsRequested: payload.notify !== false } });
      const typeTag = payload.event_type === 'job' ? 'egc-job-scheduled' : 'egc-walkthrough-scheduled';
      const reminderDays = Math.min(30, Math.max(1, Number(payload.reminder_days || 2)));
      const reminderTag = payload.notify === false ? '' : `egc-reminder-${reminderDays}d`;
      // tagSynced is true only for tags that were added: by this request, or already by the outbox.
      const tagPlan = await scheduleTagOwner(env, stored), outboxTags = tagPlan.owner === 'outbox';
      let tagSynced = !outboxTags || tagPlan.status === 'done';
      if (!outboxTags) try { await addTags(c, contactId, ['egc-hub-scheduled', typeTag, reminderTag]); } catch { tagSynced = false; }
      const stage = payload.event_type === 'job' ? await advanceOpportunity(c, contactId, c.scheduledStageId, typeTag, payload.opportunity_id || '', opportunityInput(payload, client)) : { updated: false, reason: 'walkthrough-is-not-a-booked-job' };
      const response = await finish(contactId, { ok: true, contactId, ...event, pipeline: stage, automation: { trigger: typeTag, reminderTrigger: reminderTag, tagSynced, notificationsRequested: payload.notify !== false, ...(outboxTags ? { tagOwner: 'outbox', tagStatus: tagPlan.status } : {}) } });
      await handOffTags(env, waitUntil, tagPlan);
      return response;
    }
    if (payload.tool === 'lifecycle') {
      const event = String(payload.event || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!event) return reply(400, { ok: false, error: 'Lifecycle event is required' });
      const tag = `egc-${event}`;
      if (!payload.suppress_automation) await addTags(c, contactId, [tag]);
      const appointmentStatus = ['cancelled','confirmed'].includes(String(payload.appointment_status || '').toLowerCase()) ? String(payload.appointment_status).toLowerCase() : '';
      const appointment = appointmentStatus && (payload.appointment_id||operationsEnabled(env)&&payload.job_id) ? operationsEnabled(env)
        ? await syncNativeSchedule(env,session,{portalVisitId:payload.job_id,requestId:payload.idempotency_key,contactProviderId:contactId,runAutomations:false})
        : await completeAppointment(c, payload.appointment_id, appointmentStatus) : {};
      let noteId = '';
      if (String(payload.note || '').trim()) {
        const note = operationsEnabled(env)
          ? await syncNativeNote(env,session,{portalJobId:payload.job_id,requestId:payload.idempotency_key||payload.request_id,contactId,scope:'lifecycle_'+event.slice(0,80),title:`EGC Lifecycle — ${event}`,body:String(payload.note).trim().slice(0,3000)})
          : await ghl(c, `/contacts/${encodeURIComponent(contactId)}/notes`, { method: 'POST', headers: payload.idempotency_key ? { 'Idempotency-Key': payload.idempotency_key } : {}, body: JSON.stringify({ userId: c.userId || undefined, title: `EGC Lifecycle — ${event}`, body: String(payload.note).trim().slice(0, 3000), color: '#F15A24', pinned: false }) });
        noteId = note.note?.id || '';
      }
      return finish(contactId, { ok: true, contactId, noteId, ...appointment, portalInvitation, automation: { trigger: payload.suppress_automation ? '' : tag, suppressed: Boolean(payload.suppress_automation) } });
    }
    const isCloseout = payload.tool === 'post_job';
    // A signed handoff's Job Brief and its source-walkthrough sync belong to the handoff itself (server-built
    // handoff_brief): after a Dispatch move they replay the handoff's first request instead of writing a second
    // pinned brief. Only the job's appointment follows the job's current request (payload.idempotency_key).
    const brief = handoffRequestId && payload.handoff_brief ? payload.handoff_brief : null, handoffKey = brief ? brief.idempotency_key : payload.idempotency_key || '';
    const briefPayload = brief ? { ...payload, quote: brief.quote } : payload, noteKey = brief ? brief.idempotency_key : payload.idempotency_key || payload.request_id;
    const nativeNote = body => syncNativeNote(env,session,{portalJobId:payload.job_id,requestId:noteKey,contactId,scope:isCloseout?'post_job':'game_plan',title:isCloseout?'EGC Job Closeout':'EGC Internal Job Brief',body});
    const noteText = isCloseout ? closeoutNote(payload) : noteBody(briefPayload, { signed: Boolean(brief) });
    // A brief the handoff's first sync wrote before the signed label existed keeps its original body: the same request
    // with the signed label conflicts, so it replays that body instead of failing or writing a second brief.
    const note = operationsEnabled(env)
      ? await nativeNote(noteText).catch(error => { if (!brief || isCloseout || error?.code !== 'provider_note_request_conflict') throw error; return nativeNote(noteBody(briefPayload)); })
      : await ghl(c, `/contacts/${encodeURIComponent(contactId)}/notes`, { method: 'POST', headers: payload.idempotency_key ? { 'Idempotency-Key': payload.idempotency_key } : {}, body: JSON.stringify({
      userId: c.userId || undefined, title: isCloseout ? 'EGC Job Closeout' : 'EGC Internal Job Brief',
      body: noteText, color: '#F15A24', pinned: !isCloseout
    })});
    let taskId = '';
    if (isCloseout) {
      await addTags(c, contactId, ['egc-job-complete', 'egc-review-ready']);
      // The 6-month check-in is a HighLevel task. The operations platform reports its own task id only when the
      // owner opts in (egc-api EGC_OPERATIONS_CHECKIN_TASKS_ENABLED); then HighLevel gets none, so never both.
      if(operationsEnabled(env)&&note.followupTaskId)taskId=note.followupTaskId;
      else if(operationsEnabled(env)){
        // Anchored to the saved completion (else the closeout's completed_at or sent_at) and read back before writing, so a retried closeout adds no second task. With no such anchor a retry could not find it again, so none is written.
        const saved=payload.job_id?await readJob(env,payload.job_id).catch(()=>null):null,completedAt=[saved?.completedAt,payload.completed_at,payload.sent_at].find(value=>typeof value==='string'&&Number.isFinite(Date.parse(value)))||'';
        taskId=completedAt?(await ensureHighLevelCheckin(env,{contactId,completedAt})).taskId||'':'';
      }
      else {const due = new Date(); due.setMonth(due.getMonth() + 6);
      try {
        const task = await ghl(c, `/contacts/${encodeURIComponent(contactId)}/tasks`, { method: 'POST', body: JSON.stringify({
          title: '6-month garage check-in', body: 'Ask how the system is holding up and offer maintenance / Garage Guard if useful.',
          dueDate: due.toISOString(), completed: false, assignedTo: c.userId || undefined
        })});
        taskId = task.task && task.task.id || '';
      } catch {}}
      const stage = await advanceOpportunity(c, contactId, c.jobCompleteStageId, 'egc-job-complete', payload.opportunity_id || '', opportunityInput(payload, client));
      return finish(contactId, { ok: true, contactId, noteId: note.note && note.note.id || '', taskId, pipeline: stage, automation: { trigger: 'egc-job-complete' } });
    } else {
      const savedJob = payload.job_id ? await readJob(env, payload.job_id).catch(() => null) : null;
      // Never re-enrol an accepted job when staff resave its Game Plan. Quote
      // persuasion requires the current saved estimate to still be open.
      const quoteIsOpen = savedJob && !salesExitMilestone(savedJob) && ['sent', 'open'].includes(String(savedJob.estimate?.status || '').toLowerCase());
      const sourceVisit=handoffRequestId&&savedJob?.sourceWalkthroughId?await readJob(env,savedJob.sourceWalkthroughId).catch(()=>null):null;
      const sourceCompleted=sourceVisit&&sourceVisit.customerId===savedJob.customerId&&Number.isFinite(Date.parse(sourceVisit.completedAt||''))&&['completed','paid','invoiced','closed'].includes(String(sourceVisit.pipelineStatus||sourceVisit.status));
      const visitTags=[...(!handoffRequestId||sourceCompleted?['egc-walkthrough-complete']:[]),...(quoteIsOpen?c.quoteReadyTags:[])];
      if(visitTags.length)await addTags(c,contactId,visitTags);
      const walkthrough = operationsEnabled(env)
        ? savedJob?.sourceWalkthroughId ? await syncNativeSchedule(env,session,{portalVisitId:savedJob.sourceWalkthroughId,requestId:handoffKey+':walkthrough',contactProviderId:contactId,runAutomations:false}) : {updated:false,reason:'exact-source-walkthrough-not-linked'}
        : await completeAppointment(c, client.highlevel_appointment_id || payload.walkthrough_appointment_id || '');
      const q = payload.quote || {};
      if (q.job_date && q.start_time && q.end_time) {
        const scheduled = await createAppointment(c, {
          job_id:payload.job_id,appointment_id: client.highlevel_job_appointment_id || '',
          event_type: 'job', start_time: q.start_at || `${q.job_date}T${q.start_time}:00-06:00`,
          end_time: q.end_at || `${q.job_date}T${q.end_time}:00-06:00`, title: q.title || 'EGC Garage Service',
          address: client.address, notes: appointmentInstructions(payload), notify: handoffRequestId ? payload.notify !== false : true, idempotency_key: payload.idempotency_key || '',
        }, contactId);
        const tagPlan = await scheduleTagOwner(env, savedJob), outboxTags = tagPlan.owner === 'outbox';
        let tagSynced = !outboxTags || tagPlan.status === 'done';
        if (!outboxTags) try { await addTags(c, contactId, ['egc-hub-scheduled', 'egc-job-scheduled']); } catch { tagSynced = false; }
        const stage = await advanceOpportunity(c, contactId, c.scheduledStageId, 'egc-job-scheduled', payload.opportunity_id || '', opportunityInput(payload, client));
        const response = await finish(contactId, { ok: true, contactId, noteId: note.note?.id || '', taskId, ...scheduled, walkthrough, pipeline: stage, portalInvitation, automation: { trigger: 'egc-job-scheduled', tagSynced, ...(outboxTags ? { tagOwner: 'outbox', tagStatus: tagPlan.status } : {}) } });
        await handOffTags(env, waitUntil, tagPlan);
        return response;
      }
      const stage = await advanceOpportunity(c, contactId, c.walkthroughCompleteStageId, 'egc-walkthrough-complete', payload.opportunity_id || '', opportunityInput(payload, client));
      return finish(contactId, { ok: true, contactId, noteId: note.note && note.note.id || '', taskId, walkthrough, pipeline: stage, portalInvitation, automation: { trigger: 'egc-walkthrough-complete' } });
    }
    return reply(200, { ok: true, contactId, noteId: note.note && note.note.id || '', taskId, automation: { trigger: 'egc-walkthrough-complete' } });
  } catch (error) {
    if(handoffRequestId)try{const current=await readJob(env,payload.job_id);if(current?.__updateTime&&current.handoffRequestId===handoffRequestId)await patchJob(env,payload.job_id,{handoffSyncStatus:'pending',handoffSyncError:'provider_handoff_unconfirmed',handoffLastAttemptAt:new Date().toISOString()},current.__updateTime);}catch{/* The signed job and original request remain recoverable. */}
    return reply(502, { ok: false, error: 'HighLevel rejected the field handoff', detail: error.code||error.detail || error.message,...(error.operationId?{operationId:error.operationId}:{}), portalInvitation, salesFollowupExit: await exitForJob() });
  }
}
