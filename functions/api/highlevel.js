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

const API = 'https://services.leadconnectorhq.com';
const DEFAULT_LEAD_RESET_AT = '2026-09-03T21:51:19.314Z';
const HOST = /(^|\.)easygaragecleaning\.com$|\.pages\.dev$|^localhost(:\d+)?$|^127\.0\.0\.1(:\d+)?$/;

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
    token: env.HIGHLEVEL_API_KEY || env.GHL_API_KEY || '',
    locationId: env.HIGHLEVEL_LOCATION_ID || env.GHL_LOCATION_ID || '',
    walkthroughCalendarId: env.HIGHLEVEL_WALKTHROUGH_CALENDAR_ID || env.GHL_WALKTHROUGH_CALENDAR_ID || '2yYX63nHYvUsL6KKhAc0',
    jobCalendarId: env.HIGHLEVEL_JOB_CALENDAR_ID || env.GHL_JOB_CALENDAR_ID || '2yYX63nHYvUsL6KKhAc0',
    pipelineId: env.HIGHLEVEL_PIPELINE_ID || env.GHL_PIPELINE_ID || 'anSgrMpYHtAX6YlUHnIR',
    scheduledStageId: env.HIGHLEVEL_SCHEDULED_STAGE_ID || env.GHL_SCHEDULED_STAGE_ID || env.HIGHLEVEL_PIPELINE_STAGE_SCHEDULED_ID || env.GHL_PIPELINE_STAGE_SCHEDULED_ID || '06b78f36-b53d-4028-9e36-b41ac4d2da09',
    walkthroughCompleteStageId: env.HIGHLEVEL_QUOTED_STAGE_ID || env.GHL_QUOTED_STAGE_ID || env.HIGHLEVEL_PIPELINE_STAGE_WALKTHROUGH_COMPLETE_ID || env.GHL_PIPELINE_STAGE_WALKTHROUGH_COMPLETE_ID || '85c56b3e-4886-4fc1-be95-87ad0b0d2bcc',
    jobCompleteStageId: env.HIGHLEVEL_COMPLETE_STAGE_ID || env.GHL_COMPLETE_STAGE_ID || env.HIGHLEVEL_PIPELINE_STAGE_JOB_COMPLETE_ID || env.GHL_PIPELINE_STAGE_JOB_COMPLETE_ID || '0ccca1f9-3ffb-412a-b15a-3f4be1619514',
    userId: env.HIGHLEVEL_USER_ID || env.GHL_USER_ID || 'w92vfhwm3a8twTIowpQz',
    quoteReadyTags: String(env.HIGHLEVEL_QUOTE_READY_TAGS || env.GHL_QUOTE_READY_TAGS || 'egc-quote-ready,gc-quote-open').split(',').map(x => x.trim()).filter(Boolean),
  };
}

async function ghl(c, path, options = {}) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${c.token}`,
    Version: 'v3',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
  };
  const response = await fetch(API + path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`HighLevel returned ${response.status}`);
    error.status = response.status;
    error.detail = JSON.stringify(data).slice(0, 400);
    throw error;
  }
  return data;
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
  if (configured) return configured;
  const list = await calendarList(c);
  const matcher = type === 'job' ? /job|service|clean|delivery/i : /walk|consult|estimate|quote/i;
  const preferred = list.find(x => matcher.test(x.name || '')) || list[0];
  return preferred?.id || '';
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

async function ensureContact(c, client, source = 'EGC Hub') {
  let contactId = client.highlevel_contact_id || client.ghl_contact_id || client.contactId || '';
  if (contactId) return contactId;
  const upsert = await ghl(c, '/contacts/upsert', { method: 'POST', body: JSON.stringify({
    locationId: c.locationId, name: client.name || client.customer || '', phone: client.phone || '', email: client.email || '',
    address1: client.address || '', source: client.lead_source || source
  })});
  return upsert.contact?.id || '';
}

async function addTags(c, contactId, tags) {
  const clean = [...new Set((tags || []).filter(Boolean))];
  if (!clean.length) return;
  await ghl(c, `/contacts/${encodeURIComponent(contactId)}/tags`, { method: 'POST', body: JSON.stringify({ tags: clean }) });
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
    let opportunity = null, rows = [];
    if (!opportunityId) {
      rows = await opportunities(c);
      opportunity = opportunityForContact(rows, contactId, c.pipelineId);
    } else {
      try { rows = await opportunities(c); opportunity = rows.find(row => row.id === opportunityId) || null; } catch {}
    }
    const id = opportunityId || opportunity?.id || '';
    const pipelineId = opportunity?.pipelineId || c.pipelineId;
    const name = opportunity?.name || opportunity?.contact?.name || details.name || 'EGC Garage Service';
    const suppliedValue = Number(details.monetaryValue);
    const monetaryValue = details.monetaryValue !== undefined && Number.isFinite(suppliedValue)
      ? suppliedValue : Number(opportunity?.monetaryValue || 0);
    if (!id) {
      const created = await ghl(c, '/opportunities/upsert', {
        method: 'POST',
        headers: { 'Idempotency-Key': details.idempotencyKey || `opportunity:${contactId}:${pipelineId}` },
        body: JSON.stringify({
          pipelineId, locationId: c.locationId, name, pipelineStageId: stageId,
          status: 'open', contactId, monetaryValue, assignedTo: c.userId || undefined,
          followers: c.userId ? [c.userId] : [], isRemoveAllFollowers: false, followersActionType: 'add',
        }),
      });
      const createdId = created.opportunity?.id || created.id || '';
      return { updated: true, created: true, opportunityId: createdId, pipelineStageId: stageId, fallbackTag };
    }
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

async function completeAppointment(c, appointmentId) {
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
        appointmentStatus: 'completed',
        toNotify: false,
      }),
    });
    return { updated: true, appointmentId, appointmentStatus: 'completed' };
  } catch (error) {
    return { updated: false, reason: 'update-failed', detail: error.detail || error.message };
  }
}

async function createAppointment(c, payload, contactId) {
  const type = payload.event_type === 'job' ? 'job' : 'walkthrough';
  const calendarId = payload.calendar_id || await findCalendar(c, type);
  if (!calendarId) throw new Error('No HighLevel calendar is available');
  const body = {
    calendarId,
    startTime: payload.start_time, endTime: payload.end_time,
    title: payload.title || (type === 'job' ? 'EGC Garage Service' : 'EGC Free Walkthrough'),
    appointmentStatus: payload.status || 'confirmed', assignedUserId: payload.assigned_user_id || c.userId || undefined,
    description: payload.notes || '', address: payload.address || payload.client?.address || '',
    toNotify: payload.notify !== false,
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

function noteBody(payload) {
  const p = payload || {}, q = p.quote || {}, d = p.discovery || {}, s = p.scope || {}, l = p.logistics || {};
  const list = value => Array.isArray(value) ? value.filter(Boolean).join(', ') : (value || '—');
  const finish = s.finish_details || {};
  if (p.internal_notes) return [
    'EGC INTERNAL JOB BRIEF',
    `Completed: ${p.sent_at || p.completed_at || new Date().toISOString()}`,
    `Locked total: $${Number(q.total || 0).toLocaleString('en-US')}`,
    `Deposit: $${Number(q.deposit || 0).toLocaleString('en-US')}`,
    `Target date: ${q.job_date || 'TBD'} · ${q.start_time || 'TBD'}–${q.end_time || 'TBD'}`,
    '',
    String(p.internal_notes).replace(/^EGC INTERNAL JOB BRIEF\s*/i, '').trim(),
  ].join('\n').slice(0, 4900);
  const lines = [
    'EGC WALKTHROUGH PLAN',
    `Completed: ${p.sent_at || p.completed_at || new Date().toISOString()}`,
    '',
    `Locked total: $${Number(q.total || 0).toLocaleString('en-US')}`,
    `Deposit: $${Number(q.deposit || 0).toLocaleString('en-US')}`,
    `Target date: ${q.job_date || 'TBD'}`,
    `Arrival window: ${q.start_time || 'TBD'}–${q.end_time || 'TBD'}`,
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
    `Finish: ${list(s.finish)}`,
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
    `FINISH: ${list(s.finish)}`,
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
    `Garage Guard: ${payload.garage_guard || 'not recorded'}`,
    `After photos: ${payload.photos && payload.photos.after || 0}`,
    `Drive folder: ${payload.drive_folder || '—'}`,
    `Original customer goal: ${job.customer_goal || '—'}`,
    `Original walkthrough notes: ${job.original_customer_notes || '—'}`,
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

export async function onRequestGet({ request, env }) {
  if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
  const c = config(env);
  if (!c.token || !c.locationId) return reply(501, { ok: false, code: 'HIGHLEVEL_NOT_CONFIGURED', error: 'HighLevel needs an API key and location ID' });
  const url = new URL(request.url), view = url.searchParams.get('view') || 'command';
  try {
    if (view === 'contacts') {
      const q = String(url.searchParams.get('q') || '').trim();
      if (q.length < 2) return reply(400, { ok: false, error: 'Search needs at least 2 characters' });
      return reply(200, { ok: true, contacts: await contacts(c, q) });
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
    return reply(200, { ok: true, pipelines: pipes, opportunities: opps, leadResetAt: resetAt, locationId: c.locationId });
  } catch (error) {
    return reply(502, { ok: false, error: 'HighLevel is unreachable', detail: error.detail || error.message });
  }
}

export async function onRequestPost({ request, env }) {
  if (!allowed(request)) return reply(403, { ok: false, error: 'Forbidden origin' });
  const c = config(env);
  if (!c.token || !c.locationId) return reply(501, { ok: false, code: 'HIGHLEVEL_NOT_CONFIGURED', error: 'HighLevel needs an API key and location ID' });
  const raw = await request.text();
  if (raw.length > 256 * 1024) return reply(413, { ok: false, error: 'Payload too large' });
  let payload;
  try { payload = JSON.parse(raw); } catch { return reply(400, { ok: false, error: 'Invalid JSON' }); }
  payload.idempotency_key ||= request.headers.get('Idempotency-Key') || '';
  if (!['game_plan','post_job','schedule','lifecycle'].includes(payload.tool)) return reply(400, { ok: false, error: 'Unsupported HighLevel handoff' });
  const client = payload.client || payload.job || {};
  try {
    const contactId = await ensureContact(c, { ...client, highlevel_contact_id: client.highlevel_contact_id || payload.highlevel_contact_id }, payload.tool === 'schedule' ? 'EGC Hub schedule' : payload.tool === 'lifecycle' ? 'EGC Hub lifecycle' : 'EGC walkthrough');
    if (!contactId) return reply(502, { ok: false, error: 'HighLevel did not return a contact ID' });
    if (payload.tool === 'schedule') {
      if (!payload.start_time || !payload.end_time) return reply(400, { ok: false, error: 'Schedule start and end are required' });
      const event = await createAppointment(c, payload, contactId);
      if (payload.silent_update) return reply(200, { ok: true, contactId, ...event, pipeline: { updated: false, reason: 'silent-appointment-update' }, automation: { silent: true, notificationsRequested: false } });
      const typeTag = payload.event_type === 'job' ? 'egc-job-scheduled' : 'egc-walkthrough-scheduled';
      const reminderDays = Math.min(30, Math.max(1, Number(payload.reminder_days || 2)));
      const reminderTag = payload.notify === false ? '' : `egc-reminder-${reminderDays}d`;
      let tagSynced = true;
      try { await addTags(c, contactId, ['egc-hub-scheduled', typeTag, reminderTag]); } catch { tagSynced = false; }
      const stage = await advanceOpportunity(c, contactId, c.scheduledStageId, typeTag, payload.opportunity_id || '', opportunityInput(payload, client));
      return reply(200, { ok: true, contactId, ...event, pipeline: stage, automation: { trigger: typeTag, reminderTrigger: reminderTag, tagSynced, notificationsRequested: payload.notify !== false } });
    }
    if (payload.tool === 'lifecycle') {
      const event = String(payload.event || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (!event) return reply(400, { ok: false, error: 'Lifecycle event is required' });
      const tag = `egc-${event}`;
      await addTags(c, contactId, [tag]);
      return reply(200, { ok: true, contactId, automation: { trigger: tag } });
    }
    const isCloseout = payload.tool === 'post_job';
    const note = await ghl(c, `/contacts/${encodeURIComponent(contactId)}/notes`, { method: 'POST', headers: payload.idempotency_key ? { 'Idempotency-Key': payload.idempotency_key } : {}, body: JSON.stringify({
      userId: c.userId || undefined, title: isCloseout ? 'EGC Job Closeout' : 'EGC Internal Job Brief',
      body: isCloseout ? closeoutNote(payload) : noteBody(payload), color: '#F15A24', pinned: !isCloseout
    })});
    let taskId = '';
    if (isCloseout) {
      await addTags(c, contactId, ['egc-job-complete', 'egc-review-ready']);
      const due = new Date(); due.setMonth(due.getMonth() + 6);
      try {
        const task = await ghl(c, `/contacts/${encodeURIComponent(contactId)}/tasks`, { method: 'POST', body: JSON.stringify({
          title: '6-month garage check-in', body: 'Ask how the system is holding up and offer maintenance / Garage Guard if useful.',
          dueDate: due.toISOString(), completed: false, assignedTo: c.userId || undefined
        })});
        taskId = task.task && task.task.id || '';
      } catch {}
      const stage = await advanceOpportunity(c, contactId, c.jobCompleteStageId, 'egc-job-complete', payload.opportunity_id || '', opportunityInput(payload, client));
      return reply(200, { ok: true, contactId, noteId: note.note && note.note.id || '', taskId, pipeline: stage, automation: { trigger: 'egc-job-complete' } });
    } else {
      await addTags(c, contactId, ['egc-walkthrough-complete', ...c.quoteReadyTags]);
      const walkthrough = await completeAppointment(c, client.highlevel_appointment_id || payload.walkthrough_appointment_id || '');
      const q = payload.quote || {};
      if (q.job_date && q.start_time && q.end_time) {
        const scheduled = await createAppointment(c, {
          appointment_id: client.highlevel_job_appointment_id || '',
          event_type: 'job', start_time: q.start_at || `${q.job_date}T${q.start_time}:00-06:00`,
          end_time: q.end_at || `${q.job_date}T${q.end_time}:00-06:00`, title: q.title || 'EGC Garage Service',
          address: client.address, notes: appointmentInstructions(payload), notify: true, idempotency_key: payload.idempotency_key || '',
        }, contactId);
        let tagSynced = true;
        try { await addTags(c, contactId, ['egc-hub-scheduled', 'egc-job-scheduled']); } catch { tagSynced = false; }
        const stage = await advanceOpportunity(c, contactId, c.scheduledStageId, 'egc-job-scheduled', payload.opportunity_id || '', opportunityInput(payload, client));
        return reply(200, { ok: true, contactId, noteId: note.note?.id || '', taskId, ...scheduled, walkthrough, pipeline: stage, automation: { trigger: 'egc-job-scheduled', tagSynced } });
      }
      const stage = await advanceOpportunity(c, contactId, c.walkthroughCompleteStageId, 'egc-walkthrough-complete', payload.opportunity_id || '', opportunityInput(payload, client));
      return reply(200, { ok: true, contactId, noteId: note.note && note.note.id || '', taskId, walkthrough, pipeline: stage, automation: { trigger: 'egc-walkthrough-complete' } });
    }
    return reply(200, { ok: true, contactId, noteId: note.note && note.note.id || '', taskId, automation: { trigger: 'egc-walkthrough-complete' } });
  } catch (error) {
    return reply(502, { ok: false, error: 'HighLevel rejected the field handoff', detail: error.detail || error.message });
  }
}
