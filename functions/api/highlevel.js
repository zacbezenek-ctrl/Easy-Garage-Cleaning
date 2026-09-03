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
 *   HIGHLEVEL_PIPELINE_ID
 *   HIGHLEVEL_USER_ID
 */

const API = 'https://services.leadconnectorhq.com';
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
    calendarId: env.HIGHLEVEL_WALKTHROUGH_CALENDAR_ID || env.GHL_WALKTHROUGH_CALENDAR_ID || '',
    pipelineId: env.HIGHLEVEL_PIPELINE_ID || env.GHL_PIPELINE_ID || '',
    userId: env.HIGHLEVEL_USER_ID || env.GHL_USER_ID || '',
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

async function findCalendar(c) {
  if (c.calendarId) return c.calendarId;
  const data = await ghl(c, `/calendars/?locationId=${encodeURIComponent(c.locationId)}&showDrafted=false`);
  const list = data.calendars || [];
  const preferred = list.find(x => /walk|consult|estimate|quote/i.test(x.name || '')) || list[0];
  return preferred && preferred.id || '';
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
  const calendarId = await findCalendar(c);
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

function noteBody(payload) {
  const p = payload || {}, q = p.quote || {}, d = p.discovery || {}, s = p.scope || {};
  const lines = [
    'EGC WALKTHROUGH — GARAGE COMEBACK PLAN',
    `Completed: ${p.sent_at || p.completed_at || new Date().toISOString()}`,
    '',
    `Locked total: $${Number(q.total || 0).toLocaleString('en-US')}`,
    `Deposit: $${Number(q.deposit || 0).toLocaleString('en-US')}`,
    `Target date: ${q.job_date || 'TBD'}`,
    `Why now: ${d.why_now || '—'}`,
    `Success looks like: ${d.success || '—'}`,
    `Decision maker: ${d.decision_maker || '—'}`,
    `Scope: ${s.loads || 0} truckload(s); ${s.garages || 1} garage(s)` ,
    `Keep / remove plan: ${s.keep_remove || s.sort_method || 'See signed Game Plan'}`,
    `Exclusions: ${s.exclusions || 'None recorded'}`,
    `Hazards: ${Array.isArray(s.hazards) ? s.hazards.join(', ') : (s.hazards || 'None recorded')}`,
    `Truck placement: ${s.truck_placement || '—'}`,
    '',
    p.notes || '',
  ];
  return lines.filter((x, i) => x || lines[i - 1]).join('\n').slice(0, 4900);
}

function closeoutNote(payload) {
  const job = payload.job || {};
  return [
    'EGC JOB CLOSEOUT',
    `Completed: ${payload.sent_at || new Date().toISOString()}`,
    `Customer: ${job.customer || '—'}`,
    `Locked total: $${Number(job.locked_total || job.quoted_rate || 0).toLocaleString('en-US')}`,
    `Actual truckloads: ${job.actual_loads || '—'}`,
    `Hours on site: ${job.hours_on_site || '—'}`,
    `Dump fees: $${Number(job.dump_fees || 0).toLocaleString('en-US')}`,
    `Garage Guard: ${payload.garage_guard || 'not recorded'}`,
    `After photos: ${payload.photos && payload.photos.after || 0}`,
    `Drive folder: ${payload.drive_folder || '—'}`,
    '',
    job.notes || '',
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
    const [pipes, opps] = await Promise.all([pipelines(c), opportunities(c)]);
    return reply(200, { ok: true, pipelines: pipes, opportunities: opps, locationId: c.locationId });
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
  if (!['game_plan','post_job'].includes(payload.tool)) return reply(400, { ok: false, error: 'Unsupported HighLevel handoff' });
  const client = payload.client || payload.job || {};
  try {
    let contactId = client.highlevel_contact_id || client.ghl_contact_id || payload.highlevel_contact_id || '';
    if (!contactId) {
      const upsert = await ghl(c, '/contacts/upsert', { method: 'POST', body: JSON.stringify({
        locationId: c.locationId, name: client.name || client.customer || '', phone: client.phone || '', email: client.email || '',
        address1: client.address || '', source: client.lead_source || 'EGC walkthrough', tags: ['egc-walkthrough']
      })});
      contactId = upsert.contact && upsert.contact.id || '';
    }
    if (!contactId) return reply(502, { ok: false, error: 'HighLevel did not return a contact ID' });
    const isCloseout = payload.tool === 'post_job';
    const note = await ghl(c, `/contacts/${encodeURIComponent(contactId)}/notes`, { method: 'POST', body: JSON.stringify({
      userId: c.userId || undefined, title: isCloseout ? 'EGC Job Closeout' : 'EGC Garage Comeback Plan',
      body: isCloseout ? closeoutNote(payload) : noteBody(payload), color: '#F15A24', pinned: !isCloseout
    })});
    let taskId = '';
    if (isCloseout) {
      const due = new Date(); due.setMonth(due.getMonth() + 6);
      try {
        const task = await ghl(c, `/contacts/${encodeURIComponent(contactId)}/tasks`, { method: 'POST', body: JSON.stringify({
          title: '6-month garage check-in', body: 'Ask how the system is holding up and offer maintenance / Garage Guard if useful.',
          dueDate: due.toISOString(), completed: false, assignedTo: c.userId || undefined
        })});
        taskId = task.task && task.task.id || '';
      } catch {}
    }
    return reply(200, { ok: true, contactId, noteId: note.note && note.note.id || '', taskId });
  } catch (error) {
    return reply(502, { ok: false, error: 'HighLevel rejected the field handoff', detail: error.detail || error.message });
  }
}
