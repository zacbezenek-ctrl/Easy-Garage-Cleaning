// D9/D9b: the HighLevel schedule mirror (EGC_GHL_SCHEDULE_MIRROR). A Hub schedule change commits one ghlScheduleMirror
// entry with it; the drain upserts nothing but the linked contact (outside a dry run it may upsert one), keeps ONE
// opportunity per customer job in the EGC Pipeline moving forward only (Walkthrough Appointment, Job Scheduled; created
// only through the create-only POST /opportunities/, never upsert), and writes one internal note per change. It never
// depends on a calendar: a deleted or missing calendar is "calendar mirror skipped", never a failure. A fake HighLevel
// records every request and models upsert as HighLevel does (it matches the contact's existing deal, whatever its status).
// Synthetic data, fixed clock, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { servicePublicKeySet, signServiceRequest } from '../egc-platform/services/operations/src/service-auth.ts';
import { verifyApiServiceEnvelope } from '../functions/_lib/operations-service-auth.js';
import { GHL_TAG_DRAIN_PATH, ghlTagDrainHandlers } from '../functions/api/ghl-tag-drain.js';
import { integrationStatusHandlers } from '../functions/api/integration-status.js';
import { onRequestPost as highlevelPost } from '../functions/api/highlevel.js';
import { mutateScheduledVisit } from '../functions/_lib/operations-scheduling.js';
import { GHL_D2D_SOURCE, GHL_D2D_TAGS, GHL_MIRROR_NEEDS_LINK, GHL_MIRROR_PARK_ATTEMPTS, GHL_MIRROR_STATUS_SCAN_LIMIT, GHL_SCHEDULE_MIRROR, GHL_SCHEDULE_MIRROR_LINKS, d2dAttribution, d2dNoteLine, drainScheduleMirror, firstScheduleMirrorAttempt,
  ghlD2dTagsEnabled, ghlScheduleMirrorEnabled, retryScheduleMirror, scheduleMirrorChangeKey, scheduleMirrorEntryId, scheduleMirrorEvent, scheduleMirrorIds, scheduleMirrorLinkId, scheduleMirrorStatus, scheduleMirrorStorage,
  scheduleMirrorWrites } from '../functions/_lib/ghl-schedule-mirror.js';
import { D2D_CONTACT_SOURCE, D2D_GHL_TAGS } from '../functions/_lib/knock-bridge.js';
import { MON, NOW as BRIDGE_NOW, MIN, bridgeWorld, iso, saleBatch } from './helpers/knock-bridge-fixture.mjs';
import { EGC_JOB_SCHEDULED_STAGE, EGC_PIPELINE, EGC_WALKTHROUGH_APPOINTMENT_STAGE, schedulePipeline } from '../functions/_lib/highlevel-pipeline.js';
import { EGC_JOB_CALENDAR, EGC_LOCATION, EGC_WALKTHROUGH_CALENDAR, calendarDeletedAnswer, customerCalendars } from '../functions/_lib/highlevel-calendars.js';
import { estimatorHighLevelUserId, walkthroughEstimator } from '../functions/_lib/highlevel-users.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { CALENDAR_SKIP_CODES, calendarGoneOnUpdate, chooseScheduleCalendar } from '../egc-platform/apps/api/src/schedule-calendar.ts';
import { SCHEDULE_SYNC_CALENDAR_SKIPS, runScheduleSyncTick, scheduleSyncAlerts } from '../egc-platform/apps/api/src/schedule-sync-worker.ts';
import vm from 'node:vm';
import { firestoreMemory } from './helpers/firestore-memory.mjs';
import { recordingHighLevel } from './helpers/highlevel-recorder.mjs';
import { FLAG_OFF_ENV } from './helpers/ghl-track-fixture.mjs';

const NOW = '2026-10-17T18:00:00.000Z', MINUTE = 60000, ORIGIN = 'https://easygaragecleaning.com';
const later = minutes => new Date(Date.parse(NOW) + minutes * MINUTE).toISOString();
const ENV = Object.freeze({ HIGHLEVEL_API_KEY: 'synthetic-ghl-key', HIGHLEVEL_LOCATION_ID: EGC_LOCATION, EGC_GHL_SCHEDULE_MIRROR: 'true' });
// The EGC Pipeline as HighLevel orders it (synthetic ids around the two verified ones): a deal never moves left.
const STAGES = ['new-lead', EGC_WALKTHROUGH_APPOINTMENT_STAGE, 'walkthrough-complete', EGC_JOB_SCHEDULED_STAGE, 'paid-in-full'];
const owner = { user: 'zacb', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
const crew = { user: 'crew1', displayName: 'Synthetic Crew', role: 'crew', businessAccess: false };
const roster = [{ id: 'est1', name: 'Synthetic Estimator' }, { id: 'eli', name: 'Eli Lead' }, { id: 'jo', name: 'Jo Member' }];
const resources = [{ id: 'crew_1', recordType: 'crew', name: 'Crew 1', memberIds: ['eli', 'jo'], leadId: 'eli', status: 'active' }];
const base = { customerId: 'c1', customer: 'Synthetic Customer', phone: '9705550123', email: 'synthetic@example.invalid', address: '1 Synthetic Way, Fort Collins, CO 80521', projectId: 'project_walk-1', status: 'scheduled', pipelineStatus: 'scheduled', highlevelContactId: 'contact-1', syncStatus: 'pending' };
const walkthrough = (extra = {}) => ({ ...base, type: 'walkthrough', date: '2026-10-20', time: '09:00', endDate: '2026-10-20', endTime: '10:00', assignedCrew: ['est1'], crewLead: null, ...extra });
const job = (extra = {}) => ({ ...base, type: 'job', serviceType: 'Garage transformation', date: '2026-10-22', time: '09:30', endDate: '2026-10-22', endTime: '12:30', crewId: 'crew_1', assignedCrew: ['eli', 'jo'], crewLead: 'eli',
  crewNeeded: 2, estimatedDurationMin: 180, operationalScope: { text: 'Remove junk, then install shelving, then storage totes.' }, materials: [{ id: 'quote-shelf', name: 'Metal shelf unit', quantity: 4 }, { id: 'quote-tote', name: 'Storage tote', quantity: 6 }],
  requiredEquipment: ['Dolly'], total: 1400, sourceWalkthroughId: 'walk-1', ...extra });

function memory(seed = {}) {
  const rows = new Map(); let n = 0;
  for (const [key, value] of Object.entries(seed)) rows.set(key, { ...structuredClone(value), id: key.split('/')[1], revision: `seed${++n}` });
  const all = prefix => [...rows].filter(([key]) => key.startsWith(prefix + '/')).map(([, row]) => structuredClone(row));
  const commits = [];
  return {
    ghlScheduleMirror: true, rows, commits,
    read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null),
    async commit(writes) {
      for (const write of writes) { const old = rows.get(`${write.collection}/${write.id}`); if (write.revision ? old?.revision !== write.revision : old) throw Object.assign(new Error('Conflict'), { status: 409 }); }
      for (const write of writes) rows.set(`${write.collection}/${write.id}`, { ...(write.revision ? rows.get(`${write.collection}/${write.id}`) : {}), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` });
      commits.push(writes.map(write => `${write.collection}/${write.id}`));
    },
    due: async () => ({ rows: all(GHL_SCHEDULE_MIRROR).filter(row => row.status === 'pending'), truncated: false }),
    parked: async () => ({ rows: all(GHL_SCHEDULE_MIRROR).filter(row => row.status === 'parked'), truncated: false }),
    entries: () => all(GHL_SCHEDULE_MIRROR),
    job: id => structuredClone(rows.get(`jobs/${id}`)),
  };
}

// A fake HighLevel with opportunities, the pipeline's stage order and notes; every request is recorded.
function fakeHighLevel({ opportunities = [], stages = STAGES, fail = () => 0 } = {}) {
  const calls = [], deals = new Map(opportunities.map(row => [row.id, structuredClone(row)])); let n = 0;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  async function fetcher(url, options = {}) {
    const parsed = new URL(String(url));
    assert.equal(parsed.hostname, 'services.leadconnectorhq.com');
    const method = options.method || 'GET', path = parsed.pathname, body = options.body ? JSON.parse(options.body) : null;
    const call = { method, path, search: parsed.search, headers: Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key, String(value)])), body };
    calls.push(call);
    const failure = fail(call);
    if (failure) return json(typeof failure === 'object' ? failure.body : { message: 'Synthetic HighLevel failure' }, typeof failure === 'object' ? failure.status : failure);
    if (path === '/opportunities/pipelines') return json({ pipelines: [{ id: 'other-pipeline', stages: [{ id: 'x', position: 0 }] }, { id: EGC_PIPELINE, name: 'EGC Pipeline', stages: stages.map((id, position) => ({ id, name: id, position })) }] });
    if (path === '/opportunities/search') {
      const query = parsed.searchParams, status = query.get('status') || 'open', pipeline = query.get('pipelineId');
      const rows = [...deals.values()].filter(row => row.contactId === query.get('contactId') && (status === 'all' || row.status === status) && (!pipeline || row.pipelineId === pipeline));
      return json({ opportunities: rows.map(row => structuredClone(row)), meta: { total: rows.length } });
    }
    // HighLevel's upsert matches the contact's existing deal in the pipeline, whatever its status, and overwrites it.
    if (path === '/opportunities/upsert') { const existing = [...deals.values()].find(row => row.contactId === body.contactId && row.pipelineId === body.pipelineId); const id = existing?.id || `opp-new-${++n}`; deals.set(id, { ...(existing || {}), id, ...body }); return json({ opportunity: { id } }); }
    if (path === '/opportunities/' && method === 'POST') { const id = `opp-new-${++n}`; deals.set(id, { id, ...body }); return json({ opportunity: { id } }); }
    const match = /^\/opportunities\/([^/]+)$/.exec(path);
    if (match) { const deal = deals.get(match[1]); if (!deal) return json({ message: 'Not found' }, 404); if (method === 'PUT') Object.assign(deal, body); return json({ opportunity: deal }); }
    if (/^\/contacts\/[^/]+\/notes$/.test(path)) return json({ note: { id: `note-${calls.length}` } });
    if (/^\/contacts\/[^/]+\/tags$/.test(path)) return json({ tags: body?.tags || [] });
    if (path === '/contacts/upsert') return json({ contact: { id: 'contact-new' } });
    return json({}, 404);
  }
  return { calls, deals, fetcher, lines: () => calls.map(call => `${call.method} ${call.path}`), writes: () => calls.filter(call => call.method !== 'GET'), notes: () => calls.filter(call => call.path.endsWith('/notes')), tags: () => calls.filter(call => call.path.endsWith('/tags')),
    creates: () => calls.filter(call => call.method === 'POST' && call.path === '/opportunities/'), upserts: () => calls.filter(call => call.path === '/opportunities/upsert') };
}

// The dispatch commit: the visit and its mirror entry together, or not at all.
async function save(store, id, after, { before = null, action = before ? 'schedule.update' : 'schedule.create', requestId = randomUUID(), at = NOW } = {}) {
  const writes = await scheduleMirrorWrites(store, { jobId: id, before, after, action, requestId, now: at, roster, resources });
  await store.commit([{ collection: 'jobs', id, ...(store.rows.has(`jobs/${id}`) ? { revision: store.rows.get(`jobs/${id}`).revision } : {}), patch: after }, ...writes]);
  return { writes, requestId, ids: scheduleMirrorIds(writes) };
}
const drain = (store, ghl, options = {}) => drainScheduleMirror(store, { env: ENV, now: NOW, fetcher: ghl.fetcher, ...options });

test('the flag is exactly "true"; off, no writer queues anything and the drain endpoint answers as before', async () => {
  for (const value of [undefined, '', 'TRUE', '1', 'yes']) assert.equal(ghlScheduleMirrorEnabled({ EGC_GHL_SCHEDULE_MIRROR: value }), false, String(value));
  assert.equal(ghlScheduleMirrorEnabled({ EGC_GHL_SCHEDULE_MIRROR: 'true' }), true);
  for (const store of [{}, { ghlScheduleMirror: false }, { ghlScheduleMirror: 'true' }, null]) {
    assert.deepEqual(await scheduleMirrorWrites(store, { jobId: 'walk-1', after: walkthrough(), action: 'schedule.create', requestId: randomUUID(), now: NOW }), []);
  }
  assert.equal(firstScheduleMirrorAttempt({ env: {}, waitUntil: () => assert.fail('nothing runs') }, ['gsm_' + '0'.repeat(40)], NOW), false);
});

test('stage mapping: a walkthrough moves to Walkthrough Appointment, a job, cleanout or reorg to Job Scheduled; closings move nothing', async () => {
  const store = memory();
  for (const [type, stage] of [['walkthrough', 'walkthrough_appointment'], ['job', 'job_scheduled'], ['cleanout', 'job_scheduled'], ['reorg', 'job_scheduled']]) {
    const [write] = await scheduleMirrorWrites(store, { jobId: `visit-${type}`, after: { ...walkthrough(), type }, action: 'schedule.create', requestId: randomUUID(), now: NOW });
    assert.equal(write.patch.stage, stage, type);
    assert.equal(write.collection, GHL_SCHEDULE_MIRROR);
    assert.match(write.id, /^gsm_[0-9a-f]{40}$/);
  }
  const before = walkthrough(), moved = walkthrough({ time: '10:00', endTime: '11:00' });
  const cases = [
    [null, walkthrough(), 'schedule.create', 'scheduled'],
    [before, moved, 'schedule.update', 'rescheduled'],
    [before, walkthrough({ endTime: '10:30' }), 'schedule.update', 'rescheduled'],
    [before, walkthrough({ assignedCrew: ['eli'] }), 'schedule.update', 'crew_assigned'],
    [job({ crewId: null, assignedCrew: [], crewLead: null }), job(), 'schedule.update', 'crew_assigned'],
    [before, walkthrough({ status: 'cancelled', pipelineStatus: 'cancelled' }), 'schedule.cancel', 'cancelled'],
    [job(), job({ status: 'no_show', pipelineStatus: 'no_show' }), 'schedule.no_show', 'no_show'],
    [walkthrough({ status: 'cancelled', pipelineStatus: 'cancelled' }), walkthrough(), 'schedule.restore', 'scheduled'],
    [walkthrough({ date: '', time: '', endDate: '', endTime: '', status: 'unscheduled', pipelineStatus: 'unscheduled' }), walkthrough(), 'schedule.update', 'scheduled'],
    [before, walkthrough({ notes: 'Gate code changed' }), 'schedule.update', null],
    [null, walkthrough({ date: '', time: '', endDate: '', endTime: '', status: 'unscheduled', pipelineStatus: 'unscheduled' }), 'schedule.create', null],
    [walkthrough({ date: '', time: '', endDate: '', endTime: '' }), walkthrough({ date: '', time: '', endDate: '', endTime: '', status: 'cancelled', pipelineStatus: 'cancelled' }), 'schedule.cancel', null],
    [null, { ...walkthrough(), type: 'blocked' }, 'schedule.create', null],
    [job(), job({ status: 'completed', pipelineStatus: 'completed' }), 'schedule.update', null],
  ];
  for (const [from, to, action, expected] of cases) assert.equal(scheduleMirrorEvent(from, to, action), expected, `${action} -> ${expected}`);
  const [cancel] = await scheduleMirrorWrites(store, { jobId: 'walk-1', before, after: walkthrough({ status: 'cancelled', pipelineStatus: 'cancelled' }), action: 'schedule.cancel', requestId: randomUUID(), now: NOW });
  assert.deepEqual([cancel.patch.kind, cancel.patch.stage, cancel.patch.expect], ['cancelled', null, { state: 'cancelled' }]);
  assert.deepEqual(schedulePipeline({ HIGHLEVEL_LOCATION_ID: EGC_LOCATION }), { pipelineId: 'anSgrMpYHtAX6YlUHnIR', walkthroughStageId: 'f14b91c5-a452-4e11-b0f9-bfcdd354b849', jobScheduledStageId: '9e14286c-0c24-4773-b403-790e7bbc68de' });
  assert.deepEqual(schedulePipeline({ HIGHLEVEL_LOCATION_ID: 'location-1' }), { pipelineId: '', walkthroughStageId: '', jobScheduledStageId: '' }, 'the verified ids are defaults only for the EGC location');
  assert.deepEqual(schedulePipeline({ HIGHLEVEL_LOCATION_ID: 'location-1', GHL_PIPELINE_ID: 'p', GHL_WALKTHROUGH_APPOINTMENT_STAGE_ID: 'w', HIGHLEVEL_JOB_SCHEDULED_STAGE_ID: 'j' }), { pipelineId: 'p', walkthroughStageId: 'w', jobScheduledStageId: 'j' });
});

test('note content: date, Denver window, estimator or crew, address and the job breakdown, never a price', async () => {
  const store = memory();
  const [walk] = await scheduleMirrorWrites(store, { jobId: 'walk-1', after: walkthrough(), action: 'schedule.create', requestId: randomUUID(), now: NOW, roster, resources });
  assert.equal(walk.patch.note.title, 'EGC schedule: Walkthrough booked');
  assert.deepEqual(walk.patch.note.body.split('\n'), ['EGC SCHEDULE UPDATE: Walkthrough booked', 'Date: Tuesday, October 20, 2026', 'Time: 9:00 AM – 10:00 AM (Denver time)', 'Estimator: Synthetic Estimator',
    'Address: 1 Synthetic Way, Fort Collins, CO 80521', '', 'Internal note from the EGC Hub, which keeps the schedule. The Hub sent the customer nothing.']);
  const [visit] = await scheduleMirrorWrites(store, { jobId: 'job-1', after: job(), action: 'schedule.create', requestId: randomUUID(), now: NOW, roster, resources });
  const lines = visit.patch.note.body.split('\n');
  assert.equal(visit.patch.note.title, 'EGC schedule: Job scheduled');
  for (const line of ['Date: Thursday, October 22, 2026', 'Time: 9:30 AM – 12:30 PM (Denver time)', 'Crew: Crew 1: Eli Lead (lead), Jo Member', 'Service: Garage transformation',
    'Scope: Remove junk, then install shelving, then storage totes.', 'Crew size: 2', 'Estimated time on site: 180 minutes', 'Materials (buy or load for the crew): Metal shelf unit x 4; Storage tote x 6', 'Equipment: Dolly']) assert.ok(lines.includes(line), line);
  assert.doesNotMatch(visit.patch.note.body, /\$|1400|9705550123|synthetic@example/, 'no price, phone or email in the note');
  const [cancelled] = await scheduleMirrorWrites(store, { jobId: 'job-1', before: job(), after: job({ status: 'cancelled', pipelineStatus: 'cancelled' }), action: 'schedule.cancel', requestId: randomUUID(), now: NOW, roster, resources });
  assert.equal(cancelled.patch.note.title, 'EGC schedule: Job cancelled');
  assert.ok(cancelled.patch.note.body.includes('Status: cancelled in the EGC Hub'));
  const [unassigned] = await scheduleMirrorWrites(store, { jobId: 'job-2', after: job({ crewId: null, assignedCrew: [], crewLead: null }), action: 'schedule.create', requestId: randomUUID(), now: NOW, roster, resources });
  assert.ok(unassigned.patch.note.body.includes('Crew: Not assigned yet'));
});

test('a walkthrough with no opportunity creates one at Walkthrough Appointment; its job moves the same deal to Job Scheduled', async () => {
  const store = memory(), ghl = fakeHighLevel();
  const booked = await save(store, 'walk-1', walkthrough());
  assert.equal(store.entries().length, 1);
  assert.ok(store.commits.at(-1).includes(`${GHL_SCHEDULE_MIRROR}/${booked.ids[0]}`) && store.commits.at(-1).includes('jobs/walk-1'), 'the entry commits with the visit');
  assert.equal(booked.ids[0], await scheduleMirrorEntryId('walk-1', scheduleMirrorChangeKey('dispatch', booked.requestId)), 'derived from the visit and its change key');
  const first = await drain(store, ghl);
  assert.deepEqual([first.attempted, first.done], [1, 1]);
  assert.deepEqual(ghl.lines(), ['GET /opportunities/pipelines', 'GET /opportunities/search', 'POST /opportunities/', 'POST /contacts/contact-1/notes']);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(ghl.calls[1].search)), { locationId: EGC_LOCATION, contactId: 'contact-1', pipelineId: EGC_PIPELINE, status: 'all', limit: '100', page: '1' }, 'every status, in the pipeline');
  const create = ghl.calls[2];
  assert.deepEqual([create.body.pipelineId, create.body.pipelineStageId, create.body.contactId, create.body.status, create.body.monetaryValue, create.body.assignedTo, create.body.locationId],
    [EGC_PIPELINE, EGC_WALKTHROUGH_APPOINTMENT_STAGE, 'contact-1', 'open', 0, 'w92vfhwm3a8twTIowpQz', EGC_LOCATION], 'unmapped estimator: HIGHLEVEL_USER_ID as today');
  assert.equal(create.headers['Idempotency-Key'], 'egc-schedule-mirror:project_walk-1');
  assert.equal(ghl.calls[3].headers['Idempotency-Key'], booked.ids[0], 'the note carries the entry id');
  assert.match(ghl.calls[3].body.body, /^EGC SCHEDULE UPDATE: Walkthrough booked/);
  assert.equal(ghl.calls[3].body.pinned, false);
  const done = store.entries()[0];
  assert.deepEqual([done.status, done.steps.opportunity, done.steps.opportunityId, done.steps.contactId], ['done', 'created', 'opp-new-1', 'contact-1']);
  const link = store.rows.get(`${GHL_SCHEDULE_MIRROR_LINKS}/${await scheduleMirrorLinkId('project_walk-1')}`);
  assert.deepEqual([link.opportunityId, link.contactId, link.creatingEntryId], ['opp-new-1', 'contact-1', '']);
  // The job sold from it is the same customer job (project): the same deal moves forward, no second one is created.
  ghl.calls.length = 0;
  await save(store, 'job-1', job());
  await drain(store, ghl);
  assert.deepEqual(ghl.lines(), ['GET /opportunities/pipelines', 'GET /opportunities/opp-new-1', 'PUT /opportunities/opp-new-1', 'POST /contacts/contact-1/notes']);
  assert.deepEqual([ghl.calls[2].body.pipelineStageId, ghl.calls[2].body.pipelineId], [EGC_JOB_SCHEDULED_STAGE, EGC_PIPELINE]);
  assert.equal('assignedTo' in ghl.calls[2].body, false, 'a job move never reassigns the deal');
  assert.equal('status' in ghl.calls[2].body, false, 'a move never sets a status, so a deal closed since the read is never reopened');
  assert.equal(ghl.deals.size, 1);
  assert.equal(ghl.calls.some(call => /tags|appointments|conversations/.test(call.path)), false, 'no tag, appointment or message');
  assert.equal(ghl.upserts().length, 0, 'never an upsert');
});

test('never moves backwards: a later-stage, closed or same-stage deal is left alone, and the note is still written', async () => {
  for (const [deal, outcome] of [[{ pipelineStageId: 'paid-in-full', status: 'open' }, 'later_stage'], [{ pipelineStageId: 'walkthrough-complete', status: 'open' }, 'later_stage'],
    [{ pipelineStageId: EGC_WALKTHROUGH_APPOINTMENT_STAGE, status: 'open' }, 'at_stage'], [{ pipelineStageId: 'new-lead', status: 'won' }, 'closed'], [{ pipelineStageId: 'unknown-stage', status: 'open' }, 'stage_unknown']]) {
    const store = memory(), ghl = fakeHighLevel({ opportunities: [{ id: 'opp-1', contactId: 'contact-1', pipelineId: EGC_PIPELINE, name: 'Synthetic deal', monetaryValue: 1400, ...deal }] });
    await save(store, 'walk-1', walkthrough({ highlevelOpportunityId: 'opp-1' }));
    await drain(store, ghl);
    assert.equal(ghl.calls.some(call => call.method === 'PUT' || call.path === '/opportunities/upsert' || call.path === '/opportunities/'), false, outcome);
    assert.equal(ghl.notes().length, 1, outcome);
    assert.deepEqual([store.entries()[0].status, store.entries()[0].steps.opportunity], ['done', outcome]);
  }
  // A new lead (earlier stage) adopted from the contact's only open deal moves forward and keeps its value.
  const store = memory(), ghl = fakeHighLevel({ opportunities: [{ id: 'opp-lead', contactId: 'contact-1', pipelineId: EGC_PIPELINE, name: 'Website lead', monetaryValue: 250, pipelineStageId: 'new-lead', status: 'open' }, { id: 'opp-other-pipeline', contactId: 'contact-1', pipelineId: 'other-pipeline', status: 'open', pipelineStageId: 'x' }] });
  await save(store, 'walk-1', walkthrough());
  await drain(store, ghl);
  const put = ghl.calls.find(call => call.method === 'PUT');
  assert.deepEqual([put.path, put.body.pipelineStageId, put.body.monetaryValue, put.body.name], ['/opportunities/opp-lead', EGC_WALKTHROUGH_APPOINTMENT_STAGE, 250, 'Website lead']);
  assert.deepEqual([store.entries()[0].steps.opportunity, store.entries()[0].steps.opportunityFrom], ['moved', 'new-lead']);
});

test('a repeat customer\'s won or lost deal is never reopened: no upsert, no new deal; the note is written and the entry waits for a person', async () => {
  for (const status of ['won', 'lost', 'abandoned']) {
    const paid = { id: 'opp-paid', contactId: 'contact-1', pipelineId: EGC_PIPELINE, name: 'Last year\'s garage', monetaryValue: 2400, pipelineStageId: 'paid-in-full', status };
    const store = memory(), ghl = fakeHighLevel({ opportunities: [paid] });
    // A new customer job (project) for the same contact: no link to any deal yet.
    await save(store, 'walk-2', walkthrough({ projectId: 'project_walk-2' }));
    const summary = await drain(store, ghl);
    assert.deepEqual([summary.parked, ghl.upserts().length, ghl.creates().length, ghl.calls.some(call => call.method === 'PUT'), ghl.notes().length], [1, 0, 0, false, 1], status);
    assert.deepEqual(ghl.deals.get('opp-paid'), paid, `${status}: the closed deal is untouched (stage, status and value)`);
    const [entry] = store.entries();
    assert.deepEqual([entry.status, entry.lastError, entry.steps.opportunityReview, Boolean(entry.steps.note)], ['parked', GHL_MIRROR_NEEDS_LINK, 'closed_only', true], status);
    // What an upsert would have done (the bug this guards against): HighLevel reopens and drags back the won deal.
    if (status === 'won') {
      const probe = fakeHighLevel({ opportunities: [paid] });
      await probe.fetcher('https://services.leadconnectorhq.com/opportunities/upsert', { method: 'POST', body: JSON.stringify({ pipelineId: EGC_PIPELINE, contactId: 'contact-1', pipelineStageId: EGC_WALKTHROUGH_APPOINTMENT_STAGE, status: 'open', monetaryValue: 0 }) });
      assert.deepEqual([probe.deals.get('opp-paid').status, probe.deals.get('opp-paid').pipelineStageId, probe.deals.get('opp-paid').monetaryValue], ['open', EGC_WALKTHROUGH_APPOINTMENT_STAGE, 0]);
      // A person opens a deal for the new job in HighLevel and presses Retry: the mirror adopts it and moves it forward.
      ghl.deals.set('opp-new-job', { id: 'opp-new-job', contactId: 'contact-1', pipelineId: EGC_PIPELINE, name: 'New garage job', monetaryValue: 0, pipelineStageId: 'new-lead', status: 'open' });
      const retried = await retryScheduleMirror(store, owner, { action: 'retry', requestId: randomUUID() }, later(5), {});
      await drain(store, ghl, { now: later(5), ids: retried.ids });
      const done = store.entries()[0];
      assert.deepEqual([done.status, done.steps.opportunity, done.steps.opportunityId, 'opportunityReview' in done.steps, ghl.notes().length], ['done', 'moved', 'opp-new-job', false, 1]);
      assert.deepEqual(ghl.deals.get('opp-paid'), paid, 'still untouched');
    }
  }
  // An empty search must say so (total 0): an empty list with no total is not proof, so nothing is created.
  const store = memory(), unsure = fakeHighLevel({ fail: call => call.path === '/opportunities/search' ? { status: 200, body: { opportunities: [] } } : 0 });
  await save(store, 'walk-1', walkthrough());
  const summary = await drain(store, unsure);
  assert.deepEqual([summary.retrying, unsure.creates().length, unsure.notes().length, store.entries()[0].lastError], [1, 0, 0, 'ghl_mirror_opportunity_search_unverified']);
});

test('idempotent per change: a replayed commit is refused, a done entry is never told twice, and concurrent drains write once', async () => {
  const store = memory(), ghl = fakeHighLevel();
  const { requestId } = await save(store, 'walk-1', walkthrough());
  const again = await scheduleMirrorWrites(store, { jobId: 'walk-1', after: walkthrough(), action: 'schedule.create', requestId, now: NOW });
  await assert.rejects(store.commit(again), /Conflict/, 'the same change key names the same entry, created once');
  const results = await Promise.all([drain(store, ghl), drain(store, ghl), drain(store, ghl, { ids: store.entries().map(entry => entry.id) })]);
  assert.equal(results.reduce((sum, row) => sum + row.done, 0), 1);
  assert.equal(ghl.notes().length, 1);
  assert.deepEqual([ghl.creates().length, ghl.upserts().length], [1, 0]);
  assert.equal((await drain(store, ghl, { now: later(60) })).attempted, 0);
  assert.equal(ghl.notes().length, 1);
  // A note that failed after the deal was created retries the note only.
  const second = memory(), flaky = fakeHighLevel({ fail: call => call.path.endsWith('/notes') && flaky.notes().length === 1 ? 503 : 0 });
  await save(second, 'walk-2', walkthrough({ projectId: 'project_walk-2' }));
  const failed = await drain(second, flaky);
  assert.deepEqual([failed.retrying, second.entries()[0].steps.opportunity, second.entries()[0].lastError, second.entries()[0].nextAttemptAt], [1, 'created', 'highlevel_503', later(1)]);
  await drain(second, flaky, { now: later(1) });
  assert.deepEqual([second.entries()[0].status, flaky.creates().length, flaky.notes().length], ['done', 1, 2]);
});

test('every change gets its own note, a replaced one marked as such; its stage follows the visit as it is now', async () => {
  const store = memory(), ghl = fakeHighLevel();
  // Three saves within one worker window, oldest first (the drain takes the oldest change first).
  await save(store, 'walk-1', walkthrough(), { at: later(-3) });
  await save(store, 'walk-1', walkthrough({ time: '11:00', endTime: '12:00' }), { before: walkthrough(), at: later(-2) });
  await save(store, 'walk-1', walkthrough({ time: '11:00', endTime: '12:00', assignedCrew: ['eli'] }), { before: walkthrough({ time: '11:00', endTime: '12:00' }), at: later(-1) });
  const summary = await drain(store, ghl, { limit: 5 });
  assert.deepEqual([summary.done, summary.skipped], [3, 0]);
  const byKind = Object.fromEntries(store.entries().map(entry => [entry.kind, [entry.status, entry.superseded === true, entry.steps.opportunity]]));
  assert.deepEqual(byKind, { scheduled: ['done', true, 'created'], rescheduled: ['done', true, 'at_stage'], crew_assigned: ['done', false, 'at_stage'] });
  const notes = ghl.notes().map(call => call.body);
  assert.deepEqual(notes.map(note => note.title), ['EGC schedule: Walkthrough booked (since changed)', 'EGC schedule: Walkthrough rescheduled (since changed)', 'EGC schedule: Estimator assigned'], 'one note per change, in order');
  assert.match(notes[0].body, /^Replaced: the Hub changed this visit again after this update\. The Hub has the current schedule\.\nEGC SCHEDULE UPDATE: Walkthrough booked[\s\S]*Time: 9:00 AM/);
  assert.match(notes[2].body, /^EGC SCHEDULE UPDATE: Estimator assigned[\s\S]*Time: 11:00 AM – 12:00 PM[\s\S]*Estimator: Eli Lead/);
  assert.deepEqual([ghl.creates().length, ghl.calls.filter(call => call.method === 'PUT').length], [1, 0], 'one deal, never moved twice');
  // A crew self-claim queues no entry of its own (until its dispatch call site lands): the booked job's entry is replaced,
  // and still moves the deal to Job Scheduled from the visit as it is now, with its note.
  const claimed = memory(), hl = fakeHighLevel();
  await save(claimed, 'job-1', job({ crewId: null, assignedCrew: [], crewLead: null, openShift: true }));
  claimed.rows.set('jobs/job-1', { ...claimed.rows.get('jobs/job-1'), assignedCrew: ['jo'], revision: 'claimed' });
  const after = await drain(claimed, hl);
  assert.deepEqual([after.done, after.skipped, claimed.entries()[0].superseded, claimed.entries()[0].steps.opportunity, hl.creates()[0].body.pipelineStageId, hl.notes().length], [1, 0, true, 'created', EGC_JOB_SCHEDULED_STAGE, 1]);
  // A replaced change on a visit since cancelled moves no stage (the cancellation has its own entry); the note is kept.
  const cancelled = memory(), gone = fakeHighLevel();
  await save(cancelled, 'walk-1', walkthrough());
  cancelled.rows.set('jobs/walk-1', { ...cancelled.rows.get('jobs/walk-1'), status: 'cancelled', pipelineStatus: 'cancelled', revision: 'cancelled' });
  await drain(cancelled, gone);
  assert.deepEqual([cancelled.entries()[0].status, 'opportunity' in cancelled.entries()[0].steps, gone.calls.some(call => call.path.startsWith('/opportunities')), gone.notes().length], ['done', false, false, 1]);
  // A visit deleted since: nothing is told.
  const missing = memory(), none = fakeHighLevel();
  await save(missing, 'walk-1', walkthrough());
  missing.rows.delete('jobs/walk-1');
  assert.deepEqual([(await drain(missing, none)).skipped, none.calls.length, missing.entries()[0].skipped], [1, 0, 'job_missing']);
});

test('several open deals for the customer are never guessed: the note is written and the entry parks; Retry finishes the stage', async () => {
  const deals = [{ id: 'opp-a', contactId: 'contact-1', pipelineId: EGC_PIPELINE, pipelineStageId: 'new-lead', status: 'open' }, { id: 'opp-b', contactId: 'contact-1', pipelineId: EGC_PIPELINE, pipelineStageId: 'new-lead', status: 'open' }];
  const store = memory(), ghl = fakeHighLevel({ opportunities: deals });
  await save(store, 'walk-1', walkthrough());
  const summary = await drain(store, ghl);
  assert.deepEqual([summary.parked, ghl.notes().length, ghl.calls.some(call => call.method === 'PUT' || call.path === '/opportunities/upsert')], [1, 1, false]);
  const [parked] = store.entries();
  assert.deepEqual([parked.status, parked.lastError, parked.steps.opportunityReview, Boolean(parked.steps.note)], ['parked', 'ghl_mirror_opportunity_needs_link', 'several_open', true]);
  assert.deepEqual(await scheduleMirrorStatus(store, NOW).then(row => [row.parked, row.needsLink, row.overdue]), [1, 1, 0]);
  await assert.rejects(retryScheduleMirror(store, crew, { action: 'retry', requestId: randomUUID() }, NOW, {}), error => error.code === 'ghl_mirror_forbidden');
  await assert.rejects(retryScheduleMirror(store, owner, { action: 'retry', requestId: 'not-a-uuid' }, NOW, {}), error => error.code === 'ghl_mirror_request_invalid');
  ghl.deals.get('opp-b').status = 'lost'; // someone tidied HighLevel
  const retried = await retryScheduleMirror(store, owner, { action: 'retry', requestId: randomUUID() }, later(5), {});
  assert.equal(retried.requeued, 1);
  await drain(store, ghl, { now: later(5), ids: retried.ids });
  assert.deepEqual([store.entries()[0].status, store.entries()[0].steps.opportunity, ghl.notes().length], ['done', 'moved', 1], 'the note is not written twice');
  // A link to another person's deal is never moved either.
  const other = memory(), foreign = fakeHighLevel({ opportunities: [{ id: 'opp-x', contactId: 'someone-else', pipelineId: EGC_PIPELINE, pipelineStageId: 'new-lead', status: 'open' }] });
  await save(other, 'walk-1', walkthrough({ highlevelOpportunityId: 'opp-x' }));
  await drain(other, foreign);
  assert.deepEqual([other.entries()[0].status, foreign.calls.some(call => call.method === 'PUT')], ['parked', false]);
});

test('calendar deleted or missing: the contact, deal and note still mirror (the mirror never waits for an appointment)', async () => {
  // The jobs calendar was deleted in HighLevel, so the calendar sync parked: no appointment, syncStatus error.
  const store = memory(), ghl = fakeHighLevel();
  await save(store, 'job-1', job({ syncStatus: 'error', syncError: 'schedule_calendar_deleted', syncReviewRequired: true, highlevelAppointmentId: '' }));
  const summary = await drain(store, ghl);
  assert.deepEqual([summary.done, ghl.lines()], [1, ['GET /opportunities/pipelines', 'GET /opportunities/search', 'POST /opportunities/', 'POST /contacts/contact-1/notes']]);
  assert.equal(ghl.calls[2].body.pipelineStageId, EGC_JOB_SCHEDULED_STAGE);
  assert.equal(ghl.calls[2].body.monetaryValue, 1400);
  // The verified calendars: the jobs calendar is env-only now; the walkthrough calendar keeps its default.
  assert.deepEqual(customerCalendars({ HIGHLEVEL_LOCATION_ID: EGC_LOCATION }), { jobCalendarId: '', walkthroughCalendarId: EGC_WALKTHROUGH_CALENDAR });
  assert.deepEqual(customerCalendars({ HIGHLEVEL_LOCATION_ID: EGC_LOCATION, GHL_JOB_CALENDAR_ID: 'new-jobs' }).jobCalendarId, 'new-jobs');
  assert.equal(EGC_JOB_CALENDAR, 'KuLHTd1509oEl3KntLmF');
  assert.equal(calendarDeletedAnswer({ status: 400, detail: '{"message":"The calendar is deleted."}' }), 'calendar_deleted');
  assert.equal(calendarDeletedAnswer({ status: 404 }), 'calendar_deleted');
  assert.equal(calendarDeletedAnswer({ status: 404 }, { create: false }), null, 'a missing appointment is not a deleted calendar');
  assert.equal(calendarDeletedAnswer({ status: 400, detail: 'Slot unavailable' }), null);
  assert.equal(calendarDeletedAnswer({ status: 503 }), null);
  // egc-api's choice (schedule-calendar.ts): never a name-matched default for jobs; a configured deleted calendar is a skip code.
  assert.deepEqual(chooseScheduleCalendar('job', {}, [{ id: EGC_JOB_CALENDAR, name: 'EGC Customer Jobs' }]), { skip: 'schedule_calendar_not_configured' });
  assert.deepEqual(chooseScheduleCalendar('job', { GHL_JOBS_CALENDAR_ID: EGC_JOB_CALENDAR }, [{ id: EGC_WALKTHROUGH_CALENDAR, name: 'EGC Customer Walkthroughs' }]), { skip: 'schedule_calendar_deleted' });
  assert.deepEqual(chooseScheduleCalendar('walkthrough', {}, [{ id: EGC_WALKTHROUGH_CALENDAR, name: 'EGC Customer Walkthroughs' }]), { calendarId: EGC_WALKTHROUGH_CALENDAR });
  // An existing appointment on the deleted calendar (the update path) is a skip too, never a retry.
  assert.equal(calendarGoneOnUpdate({ status: 400, body: '{"message":"The calendar is deleted."}' }, 'job', {}), true);
  assert.equal(calendarGoneOnUpdate({ status: 404, body: '{}' }, 'job', {}), true);
  assert.equal(calendarGoneOnUpdate({ status: 404, body: '{}' }, 'walkthrough', {}), false);
  assert.equal(calendarGoneOnUpdate({ status: 404, body: '{}' }, 'job', { GHL_JOBS_CALENDAR_ID: 'new-jobs' }), false);
  // The schedule-sync worker hands the skip to the Hub and counts it as calendarSkipped, never failed (no failure alert).
  assert.deepEqual([...SCHEDULE_SYNC_CALENDAR_SKIPS], [...CALENDAR_SKIP_CODES]);
  const reported = [];
  const tick = await runScheduleSyncTick({ now: () => Date.parse(NOW), execute: async (_actor, body) => {
    if (body.command === 'schedule.sync_due') return { ok: true, authority: 'employee_hub', items: [{ portalVisitId: 'job-1', requestId: 'dispatch-key:mirror', expectedRevision: 'r1' }], counts: { due: 1 }, coverage: { complete: true }, heartbeat: true };
    if (body.command === 'schedule.sync_provider') throw Object.assign(new Error('schedule_calendar_not_configured'), { code: 'schedule_calendar_not_configured', status: 409 });
    reported.push(body.code); return { ok: true, authority: 'employee_hub', syncStatus: 'synced', reviewRequired: false };
  } });
  assert.deepEqual([tick.counts.calendarSkipped, tick.counts.failed, reported, scheduleSyncAlerts(tick)], [1, 0, ['schedule_calendar_not_configured'], []]);
});

async function browserSync(t, { env, fallback, job: visitJob, payload }) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const memoryStore = firestoreMemory({ fallback });
  memoryStore.put('jobs/visit-job', visitJob);
  t.mock.method(globalThis, 'fetch', (input, options) => memoryStore.fetch(input, options));
  const cookie = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  const response = await highlevelPost({ request: new Request(`${ORIGIN}/api/highlevel`, { method: 'POST', headers: { Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }), env, waitUntil: () => {} });
  return { status: response.status, body: await response.json() };
}
const jobPayload = { tool: 'schedule', job_id: 'visit-job', idempotency_key: 'schedule:visit-job:1', event_type: 'job', appointment_id: '', opportunity_id: '', start_time: '2026-10-22T15:30:00.000Z', end_time: '2026-10-22T18:30:00.000Z', title: 'Garage transformation', address: '1 Synthetic Way', notify: true, reminder_days: 2, client: { name: 'Synthetic Customer', phone: '9705550123', email: 'synthetic@example.invalid', address: '1 Synthetic Way', highlevel_contact_id: 'contact-1' } };
const savedJob = { type: 'job', customerId: 'customer-1', customer: 'Synthetic Customer', phone: '9705550123', email: 'synthetic@example.invalid', highlevelContactId: 'contact-1', date: '2026-10-22', time: '09:30', endDate: '2026-10-22', endTime: '12:30', status: 'scheduled', pipelineStatus: 'scheduled' };

test('browser sync: a deleted jobs calendar is "calendar mirror skipped", not a failure: no tag, stage or retry storm', async t => {
  const ghl = recordingHighLevel();
  const fallback = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.pathname === '/calendars/events/appointments' && options.method === 'POST') { ghl.calls.push({ method: 'POST', path: url.pathname }); return Response.json({ message: 'The calendar is deleted.' }, { status: 400 }); }
    return ghl.fetcher(input, options);
  };
  const result = await browserSync(t, { env: { ...FLAG_OFF_ENV, HIGHLEVEL_JOB_CALENDAR_ID: EGC_JOB_CALENDAR }, fallback, job: savedJob, payload: jobPayload });
  assert.equal(result.status, 200);
  assert.deepEqual([result.body.ok, result.body.calendarMirror, result.body.appointmentId, result.body.pipeline.reason, result.body.automation.tagSynced, result.body.automation.calendarSkipped],
    [true, { status: 'skipped', reason: 'calendar_deleted' }, '', 'calendar-mirror-skipped', false, true]);
  assert.equal(ghl.calls.some(call => /\/tags$|\/opportunities/.test(call.path) && call.method !== 'GET'), false, 'no booking tag and no stage move without an appointment');
});

test('browser sync: no jobs calendar configured skips the appointment write entirely (env-only jobs calendar)', async t => {
  const ghl = recordingHighLevel();
  const env = { ...FLAG_OFF_ENV, HIGHLEVEL_LOCATION_ID: 'location-1' };
  delete env.HIGHLEVEL_JOB_CALENDAR_ID;
  const result = await browserSync(t, { env, fallback: ghl.fetcher, job: savedJob, payload: jobPayload });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.calendarMirror, { status: 'skipped', reason: 'calendar_not_configured' });
  assert.equal(ghl.calls.some(call => call.path.startsWith('/calendars/')), false);
  assert.equal(ghl.calls.some(call => call.method !== 'GET'), false);
});

test('browser sync, mirror off: a job with a calendar still moves the legacy Scheduled stage as before', async t => {
  const ghl = recordingHighLevel();
  const result = await browserSync(t, { env: { ...FLAG_OFF_ENV }, fallback: ghl.fetcher, job: savedJob, payload: jobPayload });
  assert.equal(result.status, 200);
  assert.ok(ghl.calls.some(call => call.path.startsWith('/opportunities')), 'advanceOpportunity runs with the flag off');
  assert.notEqual(result.body.pipeline.reason, 'schedule-mirror-owns-stage');
});

test('browser sync, mirror on: the mirror is the one stage writer, so the page moves no stage (two writers would disagree)', async t => {
  const ghl = recordingHighLevel();
  const result = await browserSync(t, { env: { ...FLAG_OFF_ENV, EGC_GHL_SCHEDULE_MIRROR: 'true' }, fallback: ghl.fetcher, job: savedJob, payload: jobPayload });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.pipeline, { updated: false, reason: 'schedule-mirror-owns-stage' });
  assert.equal(ghl.calls.some(call => call.path.startsWith('/opportunities')), false);
  assert.ok(ghl.calls.some(call => call.path === '/calendars/events/appointments'), 'the optional calendar mirror still runs when configured');
});

test('who is going: a walkthrough appointment and its new deal are assigned to the estimator\'s mapped HighLevel user', async t => {
  const profiles = { est1: { id: 'est1', username: 'est1', highlevelUserId: 'GhlEstimator01' } };
  const read = async (_collection, id) => ({ data: profiles[id] || null });
  assert.equal(walkthroughEstimator(walkthrough()), 'est1');
  assert.equal(walkthroughEstimator(walkthrough({ crewLead: 'Eli' })), 'eli');
  assert.equal(walkthroughEstimator(job()), '');
  assert.equal(await estimatorHighLevelUserId({ EGC_STAFF_DIRECTORY_ENABLED: 'true' }, walkthrough(), { read }), 'GhlEstimator01');
  assert.equal(await estimatorHighLevelUserId({}, walkthrough(), { read: () => assert.fail('directory off: no read') }), null);
  assert.equal(await estimatorHighLevelUserId({ EGC_STAFF_DIRECTORY_ENABLED: 'true' }, walkthrough(), { read: async () => ({ data: { username: 'est1', highlevelUserId: 'bad id!' } }) }), null);
  assert.equal(await estimatorHighLevelUserId({ EGC_STAFF_DIRECTORY_ENABLED: 'true' }, walkthrough(), { read: async () => { throw new Error('vault unavailable'); } }), null);
  const store = memory(), ghl = fakeHighLevel();
  await save(store, 'walk-1', walkthrough());
  await drain(store, ghl, { env: { ...ENV, EGC_STAFF_DIRECTORY_ENABLED: 'true' }, readProfile: read });
  assert.equal(ghl.creates()[0].body.assignedTo, 'GhlEstimator01');
  // The bridge-off browser sync passes the same user as the walkthrough appointment's assignedUserId.
  const recorder = recordingHighLevel();
  const result = await browserSync(t, { env: { ...FLAG_OFF_ENV }, fallback: recorder.fetcher, job: { ...savedJob, type: 'walkthrough', assignedCrew: ['est1'] }, payload: { ...jobPayload, event_type: 'walkthrough', title: 'EGC Free Walkthrough' } });
  assert.equal(result.status, 200);
  assert.equal(recorder.calls.find(call => call.path === '/calendars/events/appointments').body.assignedUserId, 'w92vfhwm3a8twTIowpQz', 'directory off: HIGHLEVEL_USER_ID as today');
});

test('contacts: a dry run never creates one (a never-mirrored visit closes, a linked one waits); outside it the contact is upserted', async () => {
  const unlinked = { ...walkthrough(), highlevelContactId: '', customerId: 'c2' };
  const store = memory({ 'customers/c2': { name: 'Synthetic Unlinked' } }), ghl = fakeHighLevel();
  await save(store, 'walk-1', { ...unlinked, syncStatus: 'not_needed' });
  await save(store, 'walk-2', { ...unlinked, projectId: 'project_walk-2', syncStatus: 'error' });
  const summary = await drain(store, ghl, { limit: 5 });
  assert.deepEqual([summary.skipped, summary.retrying, ghl.calls.length], [1, 1, 0]);
  const waiting = store.entries().find(entry => entry.jobId === 'walk-2');
  assert.deepEqual([waiting.status, waiting.lastError], ['pending', 'ghl_mirror_contact_not_linked']);
  // Outside a dry run the contact is upserted, then reused for this customer job.
  const live = memory({ 'customers/c2': { name: 'Synthetic Unlinked' } }), upserting = fakeHighLevel();
  await save(live, 'walk-1', { ...unlinked, syncStatus: 'not_needed' });
  await drain(live, upserting, { env: { ...ENV, EGC_MESSAGING_DRY_RUN: 'false' } });
  assert.deepEqual(upserting.lines(), ['POST /contacts/upsert', 'GET /opportunities/pipelines', 'GET /opportunities/search', 'POST /opportunities/', 'POST /contacts/contact-new/notes']);
  assert.equal(upserting.calls[0].body.source, 'EGC Hub schedule');
});

test('backoff and parking: failures wait 1, 5, 15, 60 minutes and park after 8 attempts; a stage outside the pipeline moves nothing', async () => {
  const store = memory(), ghl = fakeHighLevel({ fail: call => call.path === '/opportunities/pipelines' ? 502 : 0 });
  await save(store, 'walk-1', walkthrough());
  let at = NOW;
  for (let attempt = 1; attempt <= GHL_MIRROR_PARK_ATTEMPTS; attempt++) { await drain(store, ghl, { now: at }); at = store.entries()[0].nextAttemptAt || at; }
  const [entry] = store.entries();
  assert.deepEqual([entry.status, entry.attempts, entry.lastError], ['parked', 8, 'highlevel_502']);
  assert.equal(ghl.notes().length, 0);
  const status = await scheduleMirrorStatus(store, at);
  assert.deepEqual([status.parked, status.needsLink], [1, 0]);
  // A pipeline that lacks the stage: no move, the note is written, and the entry is done (configuration, not a retry).
  const other = memory(), missing = fakeHighLevel({ stages: ['new-lead', 'paid-in-full'] });
  await save(other, 'walk-1', walkthrough());
  await drain(other, missing);
  assert.deepEqual([other.entries()[0].status, other.entries()[0].steps.opportunity, missing.notes().length], ['done', 'not_configured', 1]);
  const elsewhere = memory(), unconfigured = fakeHighLevel();
  await save(elsewhere, 'walk-1', walkthrough());
  await drain(elsewhere, unconfigured, { env: { ...ENV, HIGHLEVEL_LOCATION_ID: 'location-1' } });
  assert.deepEqual([elsewhere.entries()[0].steps.opportunity, unconfigured.lines()], ['not_configured', ['POST /contacts/contact-1/notes']]);
});

test('bridge schedule changes queue the mirror with their own change key, in the same commit', async () => {
  const store = memory({ 'customers/c1': { name: 'Synthetic Customer', phone: '9705550123', email: 'synthetic@example.invalid', address: '1 Synthetic Way', highlevelContactId: 'contact-1' } });
  Object.assign(store, { day: async date => [...store.rows].filter(([key, row]) => key.startsWith('jobs/') && row.date === date).map(([, row]) => structuredClone(row)), legacyBlockMode: 'off', resources: async () => resources, roster: async () => roster });
  const actor = { id: 'operations-api', kind: 'integration', role: 'integration', workspace: 'egc' }, requestId = randomUUID();
  const created = await mutateScheduledVisit(store, actor, { mode: 'create', kind: 'walkthrough', requestId, portalCustomerId: 'c1', changes: { date: '2026-10-20', time: '09:00', endTime: '10:00' } }, NOW);
  const [entry] = store.entries();
  assert.equal(entry.id, await scheduleMirrorEntryId(created.visit.portalVisitId, scheduleMirrorChangeKey('bridge', requestId)));
  assert.ok(store.commits.at(-1).includes(`${GHL_SCHEDULE_MIRROR}/${entry.id}`) && store.commits.at(-1).includes(`jobs/${created.visit.portalVisitId}`));
  assert.deepEqual([entry.kind, entry.stage, entry.source], ['scheduled', 'walkthrough_appointment', 'bridge']);
  // Flag off: the bridge commit carries no mirror write.
  const off = memory({ 'customers/c1': { name: 'Synthetic Customer', highlevelContactId: 'contact-1' } });
  Object.assign(off, { ghlScheduleMirror: false, day: async () => [], legacyBlockMode: 'off' });
  await mutateScheduledVisit(off, actor, { mode: 'create', kind: 'walkthrough', requestId: randomUUID(), portalCustomerId: 'c1', changes: { date: '2026-10-20', time: '09:00', endTime: '10:00' } }, NOW);
  assert.equal(off.entries().length, 0);
  assert.equal(off.commits.flat().some(path => path.startsWith(GHL_SCHEDULE_MIRROR)), false);
});

// The signed tick: the real Hub verifier with the API key pinned in memory and a create-only nonce ledger.
const API_ROOT = 'synthetic-ghl-mirror-api-root-secret-0123456789abc';
const WORKER = Object.freeze({ id: 'ghl-tag-worker', kind: 'integration', role: 'integration', workspace: 'egc' });
const TICK_ENV = Object.freeze({ HUB_SESSION_SECRET: 'synthetic-ghl-mirror-session-secret-0123456789abc', ...ENV });
function signed() {
  const nonces = new Set(), keys = servicePublicKeySet({ service: 'api', rootSecret: API_ROOT, workspace: 'egc' });
  const firestoreFetch = async (_env, url, init) => { const name = JSON.parse(init.body).writes[0].update.name; if (nonces.has(name)) return new Response('{}', { status: 409 }); nonces.add(name); return Response.json({}); };
  return (env, token, path, options) => verifyApiServiceEnvelope(env, token, path, { ...options, resolveKey: async () => (await keys).keys[0], firestoreFetch });
}
const envelope = () => signServiceRequest({ service: 'api', rootSecret: API_ROOT, workspace: 'egc', path: GHL_TAG_DRAIN_PATH, actor: WORKER, request: { requestId: randomUUID(), body: { command: 'ghl_tags.drain' } }, now: Date.parse(NOW) });
const tick = async (handlers, env) => { const response = await handlers.post({ request: new Request(`${ORIGIN}${GHL_TAG_DRAIN_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ envelope: await envelope() }) }), env }); return { status: response.status, body: await response.json() }; };

test('the signed worker tick drains the mirror (with or without the tag outbox) and records the check-in; both off answers as before', async () => {
  const store = memory(), ghl = fakeHighLevel();
  await save(store, 'walk-1', walkthrough());
  const handlers = ghlTagDrainHandlers({ verify: signed(), storage: () => store, mirrorStorage: () => store, now: () => new Date(NOW), fetcher: ghl.fetcher });
  const mirrorOnly = await tick(handlers, TICK_ENV);
  assert.deepEqual([mirrorOnly.status, mirrorOnly.body.ok, mirrorOnly.body.summary, mirrorOnly.body.mirror.done, mirrorOnly.body.checkedIn], [200, true, null, 1, true]);
  assert.equal(store.rows.get('ghlTagDrainState/worker').lastRunAt, NOW);
  const off = await tick(handlers, { ...TICK_ENV, EGC_GHL_SCHEDULE_MIRROR: 'false' });
  assert.deepEqual(off, { status: 409, body: { ok: false, code: 'ghl_tag_outbox_disabled', error: 'The HighLevel tag outbox is turned off. Nothing was sent.' } });
  // Tag outbox on, mirror off: the answer has no mirror key at all (byte-identical to the tag outbox alone).
  const tagsOnly = await tick(handlers, { ...TICK_ENV, EGC_GHL_SCHEDULE_MIRROR: '', EGC_GHL_TAG_OUTBOX: 'true' });
  assert.equal(tagsOnly.status, 200);
  assert.deepEqual(Object.keys(tagsOnly.body), ['ok', 'summary', 'checkedIn']);
});

test('Integrations: the jobs calendar reads as optional whatever the mirror flag says; the mirror reports its queue only with the flag on, counts only', async () => {
  const status = async (viewer, env, mirrorStatus) => (await (await integrationStatusHandlers({ session: async () => viewer, revocations: () => null, scheduleSync: async () => false, now: () => new Date(NOW), ...(mirrorStatus ? { mirrorStatus } : {}) })
    .get({ request: new Request(`${ORIGIN}/api/integration-status`), env })).json()).status;
  // The calendar change is live with the mirror off (env-only jobs calendar), so its state is too once HighLevel is
  // configured; no mirror key is read or sent.
  const live = { HIGHLEVEL_API_KEY: 'synthetic-ghl-key', HIGHLEVEL_LOCATION_ID: EGC_LOCATION };
  const off = await status(owner, { ...live, HIGHLEVEL_JOB_CALENDAR_ID: 'new-jobs' }, () => assert.fail('flag off: nothing is read'));
  assert.equal(['ghlScheduleMirror', 'ghlScheduleMirrorState'].some(key => key in off), false, 'flag off: no mirror key');
  assert.equal(off.highlevelJobCalendar, true);
  assert.equal((await status(owner, live, () => assert.fail('flag off: nothing is read'))).highlevelJobCalendar, false, 'no default jobs calendar any more, flag off too');
  assert.equal('highlevelJobCalendar' in await status(owner, { HIGHLEVEL_LOCATION_ID: EGC_LOCATION, HIGHLEVEL_JOB_CALENDAR_ID: 'new-jobs' }), false, 'HighLevel not configured, mirror off: the answer is unchanged');
  assert.equal((await status(owner, ENV, async () => ({ enabled: true }))).highlevelJobCalendar, false);
  assert.equal((await status(owner, { ...ENV, HIGHLEVEL_JOB_CALENDAR_ID: 'new-jobs' }, async () => ({ enabled: true }))).highlevelJobCalendar, true);
  const queue = { enabled: true, parked: 2, needsLink: 1, overdue: 0, pending: 3, drain: { lastRunAt: NOW, minutesSince: 0, stale: false }, complete: true, asOf: NOW };
  const on = await status(owner, ENV, async () => queue);
  assert.deepEqual([on.ghlScheduleMirror, on.ghlScheduleMirrorState], [true, { ...queue, pipelineConfigured: true, canRetry: true }]);
  const crewView = await status(crew, ENV, () => assert.fail('crew: the queue is not read'));
  assert.deepEqual([crewView.ghlScheduleMirror, 'ghlScheduleMirrorState' in crewView], [true, false]);
  const broken = await status(owner, ENV, async () => { throw new Error('unavailable'); });
  assert.equal(broken.ghlScheduleMirrorState.state, 'unavailable');
});

test('Integrations reads stay small: parked entries are counted by aggregation (never read), pending ones are capped', async () => {
  const requests = [];
  const firestore = async (_env, url, init = {}) => {
    const body = JSON.parse(init.body || '{}'); requests.push({ url: String(url), body });
    if (String(url).endsWith(':runAggregationQuery')) {
      const filters = body.structuredAggregationQuery.structuredQuery.where.compositeFilter?.filters.map(row => row.fieldFilter) || [body.structuredAggregationQuery.structuredQuery.where.fieldFilter];
      const value = filters.length === 1 ? '120' : '7';
      return Response.json([{ result: { aggregateFields: { count: { integerValue: value } } }, readTime: '2026-10-17T18:00:00.123456Z' }]);
    }
    if (String(url).endsWith(':runQuery')) return Response.json([]);
    return new Response('{}', { status: 404 });
  };
  const store = scheduleMirrorStorage({}, firestore);
  assert.deepEqual(await store.parkedCounts(), { parked: 120, needsLink: 7, complete: true });
  const [parked, needsLink] = requests.map(row => row.body.structuredAggregationQuery);
  assert.deepEqual(parked.structuredQuery.where, { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'parked' } } });
  assert.deepEqual(needsLink.structuredQuery.where.compositeFilter.filters.map(row => row.fieldFilter.value.stringValue), ['parked', GHL_MIRROR_NEEDS_LINK], 'equality filters only: no composite index');
  assert.deepEqual(parked.aggregations, [{ alias: 'count', count: {} }]);
  requests.length = 0;
  await store.due(GHL_MIRROR_STATUS_SCAN_LIMIT);
  assert.equal(requests[0].body.structuredQuery.limit, GHL_MIRROR_STATUS_SCAN_LIMIT + 1);
  requests.length = 0;
  await store.due();
  assert.equal(requests[0].body.structuredQuery.limit, 501, 'the drain keeps its own scan');
  // An unreadable count is never zero.
  await assert.rejects(scheduleMirrorStorage({}, async () => Response.json([{ result: {} }])).parkedCounts(), error => error.code === 'ghl_mirror_storage_incomplete');
  await assert.rejects(scheduleMirrorStorage({}, async () => new Response('{}', { status: 429 })).parkedCounts(), error => error.code === 'ghl_mirror_storage_unavailable');
  // The status uses the counts and never reads the parked rows; a store without counts (tests) counts its rows.
  const counted = { parkedCounts: async () => ({ parked: 120, needsLink: 7, complete: true }), parked: () => assert.fail('parked rows are not read'), due: async limit => { assert.equal(limit, GHL_MIRROR_STATUS_SCAN_LIMIT); return { rows: [], truncated: false }; }, read: async () => null };
  assert.deepEqual(await scheduleMirrorStatus(counted, NOW).then(row => [row.parked, row.needsLink, row.overdue, row.pending, row.complete]), [120, 7, 0, 0, true]);
});

test('the Integrations Retry requeues only the schedule mirror (scope schedule_mirror), never a tag; mirror off, the scope is not read', async () => {
  const store = memory(), ghl = fakeHighLevel({ opportunities: [{ id: 'opp-a', contactId: 'contact-1', pipelineId: EGC_PIPELINE, pipelineStageId: 'new-lead', status: 'open' }, { id: 'opp-b', contactId: 'contact-1', pipelineId: EGC_PIPELINE, pipelineStageId: 'new-lead', status: 'open' }] });
  await save(store, 'walk-1', walkthrough());
  await drain(store, ghl);
  assert.equal(store.entries()[0].status, 'parked');
  const tagStore = () => ({ parked: () => assert.fail('no tag is retried'), due: () => assert.fail('no tag is retried'), commit: () => assert.fail('no tag is retried') });
  const handlers = (viewer = owner) => ghlTagDrainHandlers({ session: async () => viewer, storage: tagStore, mirrorStorage: () => store, now: () => new Date(later(5)), fetcher: ghl.fetcher });
  const post = async (env, body, viewer) => { const response = await handlers(viewer).post({ request: new Request(`${ORIGIN}${GHL_TAG_DRAIN_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify(body) }), env, waitUntil: () => {} }); return { status: response.status, body: await response.json() }; };
  const both = { ...ENV, EGC_GHL_TAG_OUTBOX: 'true' };
  assert.deepEqual((await post(both, { action: 'retry', requestId: randomUUID(), scope: 'tags' })).body.code, 'ghl_mirror_request_invalid');
  assert.equal((await post(both, { action: 'retry', requestId: randomUUID(), scope: 'schedule_mirror' }, crew)).status, 403);
  const retried = await post(both, { action: 'retry', requestId: randomUUID(), scope: 'schedule_mirror' });
  assert.deepEqual([retried.status, retried.body.requeued, retried.body.mirror.requeued], [200, 0, 1]);
  assert.equal(store.entries()[0].status, 'pending');
  // Mirror off: the scope is not read, so the tag outbox answers exactly as it did before (it rejects the unknown key).
  const tagsOnly = await ghlTagDrainHandlers({ session: async () => owner, storage: () => memory(), mirrorStorage: () => assert.fail('mirror off'), now: () => new Date(NOW) })
    .post({ request: new Request(`${ORIGIN}${GHL_TAG_DRAIN_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ action: 'retry', requestId: randomUUID(), scope: 'schedule_mirror' }) }), env: { ...ENV, EGC_GHL_SCHEDULE_MIRROR: '', EGC_GHL_TAG_OUTBOX: 'true' } });
  assert.deepEqual([tagsOnly.status, (await tagsOnly.json()).code], [400, 'ghl_tag_request_invalid']);
});

// The real employee-suite.js in a VM with a fake Hub API: the Integrations rows for the mirror and the jobs calendar.
function integrationsPage(integrations) {
  const calls = [], response = body => ({ ok: true, status: 200, json: async () => body });
  const values = new Map([['egc_u', 'ZacB'], ['egc_business_access', 'true'], ['egc_owner', 'true'], ['egc_role', 'owner']]);
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  const context = {
    console, URLSearchParams, Intl, Promise, Set, Map, Error, JSON, Math, Number, String, Array, Object, Date, crypto: { randomUUID },
    sessionStorage: storage, localStorage: storage, navigator: {}, me: 'ZacB', location: { pathname: '/employee', search: '' }, jobsCache: [],
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, addEventListener() {},
    document: { readyState: 'loading', hidden: false, activeElement: null, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
  };
  context.window = context;
  context.hubFetch = async (url, init = {}) => { calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null }); return url === '/api/ghl-tag-drain' ? response({ ok: true, requestId: 'x', requeued: 0, ids: [], mirror: { ok: true, requeued: 2, ids: [] } }) : response({ ok: true, status: integrations }); };
  const source = readFileSync(new URL('../employee-suite.js', import.meta.url), 'utf8').replace(/\}\)\(\);\s*$/, 'Object.assign(globalThis,{ui:{S,integrationRow}});})();');
  vm.runInNewContext(source, context);
  Object.assign(context.ui.S, { integrations, integrationState: { loaded: true, loading: false, error: '' } });
  return { context, calls, row: key => context.ui.integrationRow([key, 'Synthetic', key, 'HINT']) };
}

test('Integrations UI: the gated mirror reads "Off" (info, not a warning); with parked entries a dispatcher gets a scoped Retry', async () => {
  const off = integrationsPage({ highlevel: true, highlevelJobCalendar: false });
  assert.match(off.row('ghlScheduleMirror'), /class="ops-status info">Off · gated on workflow audit</);
  assert.doesNotMatch(off.row('ghlScheduleMirror'), /Needs setup|ops-status warn/);
  assert.match(off.row('highlevelJobCalendar'), /class="ops-status info">Optional · not set</, 'the jobs calendar row shows with the mirror off');
  assert.match(off.row('highlevelJobCalendar'), /job visits skip the calendar mirror; their HighLevel contact is still linked \(the schedule mirror is off\)/);
  const queue = { enabled: true, parked: 2, needsLink: 1, overdue: 0, pending: 0, drain: { lastRunAt: NOW, minutesSince: 1, stale: false }, complete: true, pipelineConfigured: true, canRetry: true };
  const on = integrationsPage({ highlevel: true, ghlScheduleMirror: true, ghlScheduleMirrorState: queue, highlevelJobCalendar: false });
  const row = on.row('ghlScheduleMirror');
  assert.match(row, /2 parked \(1 need a person in HighLevel/);
  assert.match(row, /onclick="opsRetryScheduleMirror\(this\)">Retry<\/button>/);
  assert.doesNotMatch(integrationsPage({ highlevel: true, ghlScheduleMirror: true, ghlScheduleMirrorState: { ...queue, canRetry: false }, highlevelJobCalendar: false }).row('ghlScheduleMirror'), /opsRetryScheduleMirror/, 'no Retry without dispatch.write');
  assert.doesNotMatch(integrationsPage({ highlevel: true, ghlScheduleMirror: true, ghlScheduleMirrorState: { ...queue, parked: 0, needsLink: 0 }, highlevelJobCalendar: false }).row('ghlScheduleMirror'), /opsRetryScheduleMirror/, 'nothing to retry');
  await on.context.opsRetryScheduleMirror(null);
  const sent = on.calls.find(call => call.url === '/api/ghl-tag-drain');
  assert.deepEqual([sent.method, sent.body.action, sent.body.scope, /^[0-9a-f-]{36}$/.test(sent.body.requestId)], ['POST', 'retry', 'schedule_mirror', true]);
  assert.ok(on.calls.some(call => call.url === '/api/integration-status'), 'the counts are read again after the Retry');
});

// The dispatch writer (functions/_lib/dispatch-service.js) queues the mirror through scheduleMirrorWrites next to the tag
// outbox, with dispatch-storage carrying the flag.
test('dispatch saves queue the mirror in the same commit: book, assign a crew, move; a notes-only save queues nothing', async () => {
  const { mutateDispatch } = await import('../functions/_lib/dispatch-service.js');
  const store = memory({ 'customers/c1': { name: 'Synthetic Customer', phone: '+1 (970) 555-0123', email: 'synthetic@example.invalid', address: '1 Synthetic Way', highlevelContactId: 'contact-1' } });
  const people = [{ id: 'zacb', name: 'Synthetic Owner', role: 'owner' }, { id: 'eli', name: 'Eli Lead', role: 'crew' }, { id: 'jo', name: 'Jo Member', role: 'crew' }];
  const all = prefix => [...store.rows].filter(([key]) => key.startsWith(prefix + '/')).map(([, row]) => structuredClone(row));
  Object.assign(store, { jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => all('customers'), roster: async () => structuredClone(people) });
  const mutate = input => mutateDispatch(store, owner, input, NOW);
  const created = await mutate({ action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'job', changes: { date: '2026-10-22', time: '09:30', endTime: '12:30', jobInstructions: 'Synthetic job' } });
  const id = created.job.id, revision = () => store.rows.get(`jobs/${id}`).revision;
  await mutate({ action: 'schedule.update', requestId: randomUUID(), jobId: id, expectedRevision: revision(), changes: { assignedCrew: ['eli', 'jo'] } });
  await mutate({ action: 'schedule.update', requestId: randomUUID(), jobId: id, expectedRevision: revision(), changes: { notes: 'Gate code changed' } });
  await mutate({ action: 'schedule.update', requestId: randomUUID(), jobId: id, expectedRevision: revision(), changes: { date: '2026-10-23' } });
  const entries = store.entries();
  assert.deepEqual(entries.map(entry => entry.kind).sort(), ['crew_assigned', 'rescheduled', 'scheduled']);
  for (const entry of entries) assert.ok(store.commits.some(paths => paths.includes(`${GHL_SCHEDULE_MIRROR}/${entry.id}`) && paths.includes(`jobs/${id}`)), `${entry.kind} commits with its change`);
  const ghl = fakeHighLevel();
  const summary = await drain(store, ghl, { limit: 10 });
  assert.deepEqual([summary.done, summary.skipped, ghl.notes().length], [3, 0, 3], 'every change is told');
  assert.equal(ghl.notes().filter(call => / \(since changed\)$/.test(call.body.title)).length, 2, 'the two replaced changes are marked');
  const current = ghl.notes().map(call => call.body).find(note => note.title === 'EGC schedule: Job rescheduled');
  assert.match(current.body, /^EGC SCHEDULE UPDATE: Job rescheduled[\s\S]*Friday, October 23, 2026[\s\S]*Crew: Eli Lead, Jo Member/);
  assert.deepEqual([ghl.creates().length, ghl.upserts().length], [1, 0], 'one deal for the customer job, created once');
  store.ghlScheduleMirror = false;
  await mutate({ action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'walkthrough', changes: { date: '2026-10-24', time: '09:00', endTime: '10:00' } });
  assert.equal(store.entries().length, 3, 'flag off: dispatch writes no mirror entry');
});

// The crew self-claim and release (mutateDispatchSelfAssignment) queue the mirror too, once that call site is merged.
test('a crew self-claim and release queue the mirror as a crew change, in the same commit', async () => {
  const { mutateDispatch, mutateDispatchSelfAssignment } = await import('../functions/_lib/dispatch-service.js');
  const store = memory({ 'customers/c1': { name: 'Synthetic Customer', phone: '+1 (970) 555-0123', email: 'synthetic@example.invalid', address: '1 Synthetic Way', highlevelContactId: 'contact-1' } });
  const people = [{ id: 'zacb', name: 'Synthetic Owner', role: 'owner' }, { id: 'eli', name: 'Eli Lead', role: 'crew' }, { id: 'jo', name: 'Jo Member', role: 'crew' }];
  const all = prefix => [...store.rows].filter(([key]) => key.startsWith(prefix + '/')).map(([, row]) => structuredClone(row));
  Object.assign(store, { jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => all('customers'), roster: async () => structuredClone(people) });
  const created = await mutateDispatch(store, owner, { action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'job', changes: { date: '2026-10-22', time: '09:30', endTime: '12:30', assignedCrew: ['eli'], crewNeeded: 2, jobInstructions: 'Synthetic job' } }, NOW);
  Object.assign(store.rows.get(`jobs/${created.job.id}`), { openShift: true, shiftPickupEnabled: true });
  const claim = { action: 'claim', jobId: created.job.id, requestId: randomUUID() };
  await mutateDispatchSelfAssignment(store, { user: 'jo' }, claim, NOW);
  const entry = store.entries().find(row => row.requestId === claim.requestId);
  assert.deepEqual([entry.kind, entry.stage, entry.source], ['crew_assigned', 'job_scheduled', 'dispatch']);
  assert.ok(store.commits.some(paths => paths.includes(`${GHL_SCHEDULE_MIRROR}/${entry.id}`) && paths.includes(`jobs/${created.job.id}`)), 'commits with the claim');
  assert.match(entry.note.body, /Crew assigned[\s\S]*Crew: Eli Lead, Jo Member/);
  const release = { action: 'release', jobId: created.job.id, requestId: randomUUID() };
  await mutateDispatchSelfAssignment(store, { user: 'jo' }, release, NOW);
  assert.equal(store.entries().find(row => row.requestId === release.requestId).kind, 'crew_assigned');
});

// KNOCK-BRIDGE + D9b: a door-to-door job (the Knock bridge's source 'door_to_door', d2d and ghlTags) reaches HighLevel
// attributed: a note line naming the rep, the source "Door to door" on what the mirror creates, and its own tag only
// with EGC_GHL_D2D_TAGS (tags start HighLevel workflows).
const D2D_ENV = Object.freeze({ ...ENV, EGC_GHL_D2D_TAGS: 'true' });
const REPS = Object.freeze({ 'knock_reps/rep.one': { repKey: 'rep.one', username: 'Rep.One', displayName: 'Sam Rivera', status: 'active' } });
const d2dSale = (extra = {}) => job({ projectId: 'project_d2d-sale', source: 'door_to_door', knockSaleId: 'sale-1', ghlTags: ['egc-d2d-sale'],
  d2d: { kind: 'sale', repKey: 'rep.one', saleId: 'sale-1', houseId: 'h-1-synthetic-way', contactSource: 'Door to door', at: NOW }, ...extra });
const d2dWalk = (extra = {}) => walkthrough({ projectId: 'project_d2d-walk', source: 'door_to_door', knockWalkthroughId: 'walk-evt-1', ghlTags: ['egc-d2d-walkthrough'],
  d2d: { kind: 'walkthrough', repKey: 'rep.one', setterEventId: 'walk-evt-1', houseId: 'h-1-synthetic-way', contactSource: 'Door to door', at: NOW }, ...extra });
const noteLines = ghl => ghl.notes().map(call => call.body.body.split('\n'));
const twoOpenDeals = () => [{ id: 'opp-a', contactId: 'contact-1', pipelineId: EGC_PIPELINE, pipelineStageId: 'new-lead', status: 'open' }, { id: 'opp-b', contactId: 'contact-1', pipelineId: EGC_PIPELINE, pipelineStageId: 'new-lead', status: 'open' }];

test('door to door: the attribution is read from the visit (the bridge\'s own values), never queued, and only the two D2D tags ever leave a job', async () => {
  assert.equal(GHL_D2D_SOURCE, D2D_CONTACT_SOURCE);
  assert.deepEqual({ ...GHL_D2D_TAGS }, { ...D2D_GHL_TAGS }, 'the mirror\'s copy matches the Knock bridge');
  assert.deepEqual(d2dAttribution(d2dSale()), { kind: 'sale', repKey: 'rep.one', tags: ['egc-d2d-sale'] });
  assert.deepEqual(d2dAttribution(d2dWalk()), { kind: 'walkthrough', repKey: 'rep.one', tags: ['egc-d2d-walkthrough'] });
  for (const visit of [job(), job({ ghlTags: ['egc-d2d-sale'] }), d2dSale({ source: 'website' }), d2dSale({ d2d: { kind: 'flyer', repKey: 'rep.one' } }), d2dSale({ d2d: null }), d2dSale({ d2d: ['sale'] })]) assert.equal(d2dAttribution(visit), null);
  assert.deepEqual(d2dAttribution(d2dSale({ ghlTags: ['egc-hub-scheduled', 'egc-d2d-sale', 'egc-reminder-1d', 'egc-d2d-sale'] })).tags, ['egc-d2d-sale'], 'an allowlist, never another tag the job holds');
  assert.deepEqual(d2dAttribution(d2dSale({ ghlTags: 'egc-d2d-sale' })).tags, []);
  for (const repKey of ['../knock_settings/current', '..', 'Rep.One', '']) assert.equal(d2dAttribution(d2dSale({ d2d: { kind: 'sale', repKey } })).repKey, '', `${repKey}: not a rep key, never read`);
  assert.equal(d2dNoteLine('sale', 'Sam'), 'Door to door: sale set by Sam');
  assert.equal(d2dNoteLine('walkthrough', ''), 'Door to door: walkthrough set by a door-to-door rep');
  // The bridge attributes its job in the same commit, after the entry is built: the queued note is the change's own.
  const [entry] = await scheduleMirrorWrites(memory(), { jobId: 'job-d2d', after: d2dSale(), action: 'schedule.create', requestId: randomUUID(), now: NOW, roster, resources });
  assert.doesNotMatch(JSON.stringify(entry.patch), /Door to door|egc-d2d/);
  assert.deepEqual(await scheduleMirrorWrites({ ghlScheduleMirror: false }, { jobId: 'job-d2d', after: d2dSale(), action: 'schedule.create', requestId: randomUUID(), now: NOW }), [], 'mirror off: nothing, whatever EGC_GHL_D2D_TAGS says');
});

test('door to door: the note names the rep by first name; a deal or contact the mirror creates says "Door to door", a moved deal keeps its own source', async () => {
  const store = memory(REPS), ghl = fakeHighLevel();
  await save(store, 'job-d2d', d2dSale());
  assert.equal((await drain(store, ghl)).done, 1);
  assert.deepEqual(ghl.lines(), ['GET /opportunities/pipelines', 'GET /opportunities/search', 'POST /opportunities/', 'POST /contacts/contact-1/notes'], 'no tag without EGC_GHL_D2D_TAGS');
  const create = ghl.creates()[0];
  assert.deepEqual([create.body.source, create.body.pipelineStageId, create.body.status, create.headers['Idempotency-Key']], ['Door to door', EGC_JOB_SCHEDULED_STAGE, 'open', 'egc-schedule-mirror:project_d2d-sale']);
  const [lines] = noteLines(ghl), queued = store.entries()[0].note.body.split('\n');
  assert.deepEqual(lines.slice(0, 3), ['EGC SCHEDULE UPDATE: Job scheduled', 'Door to door: sale set by Sam', 'Date: Thursday, October 22, 2026']);
  assert.deepEqual([lines[0], ...lines.slice(2)], queued, 'the rest of the note is the change as it was queued');
  assert.doesNotMatch(lines.join('\n'), /Rivera|rep\.one|sale-1|\$|1400/, 'first name only: no surname, rep key, sale id or price');
  assert.deepEqual([store.entries()[0].steps.opportunity, store.entries()[0].steps.opportunitySource], ['created', 'set']);
  // A walkthrough set at the door, twice for the same rep: one profile read per rep per drain pass.
  const walks = memory(REPS), hl = fakeHighLevel(), read = walks.read;
  let repReads = 0;
  walks.read = async (collection, id) => { if (collection === 'knock_reps') repReads++; return read(collection, id); };
  await save(walks, 'walk-d2d', d2dWalk());
  await save(walks, 'walk-d2d-2', d2dWalk({ projectId: 'project_d2d-walk-2', highlevelContactId: 'contact-2' }));
  await drain(walks, hl, { limit: 5 });
  assert.deepEqual(noteLines(hl).map(rows => rows.slice(0, 2)), [['EGC SCHEDULE UPDATE: Walkthrough booked', 'Door to door: walkthrough set by Sam'], ['EGC SCHEDULE UPDATE: Walkthrough booked', 'Door to door: walkthrough set by Sam']]);
  assert.equal(repReads, 1);
  assert.deepEqual(hl.creates().map(call => [call.body.source, call.body.pipelineStageId]), [['Door to door', EGC_WALKTHROUGH_APPOINTMENT_STAGE], ['Door to door', EGC_WALKTHROUGH_APPOINTMENT_STAGE]]);
  // A replaced change keeps its marker first; a rep with no canvassing profile is named generically.
  const replaced = memory(), unnamed = fakeHighLevel();
  await save(replaced, 'walk-d2d', d2dWalk());
  replaced.rows.set('jobs/walk-d2d', { ...replaced.rows.get('jobs/walk-d2d'), time: '11:00', endTime: '12:00', revision: 'moved' });
  await drain(replaced, unnamed);
  assert.deepEqual(noteLines(unnamed)[0].slice(0, 3), ['Replaced: the Hub changed this visit again after this update. The Hub has the current schedule.', 'EGC SCHEDULE UPDATE: Walkthrough booked', 'Door to door: walkthrough set by a door-to-door rep']);
  // The contact's own deal (a website lead) is moved, never given the door-to-door source.
  const moved = memory(REPS), existing = fakeHighLevel({ opportunities: [{ id: 'opp-lead', contactId: 'contact-1', pipelineId: EGC_PIPELINE, name: 'Website lead', monetaryValue: 250, pipelineStageId: 'new-lead', status: 'open', source: 'Website' }] });
  await save(moved, 'job-d2d', d2dSale());
  await drain(moved, existing);
  const put = existing.calls.find(call => call.method === 'PUT');
  assert.deepEqual([put.path, 'source' in put.body, existing.deals.get('opp-lead').source, existing.creates().length, 'opportunitySource' in moved.entries()[0].steps], ['/opportunities/opp-lead', false, 'Website', 0, false]);
  // A contact the mirror upserts (outside a dry run) for a door-to-door job: source "Door to door".
  const live = memory({ ...REPS, 'customers/c9': { name: 'Synthetic Door Customer' } }), upserting = fakeHighLevel();
  await save(live, 'job-d2d', d2dSale({ highlevelContactId: '', customerId: 'c9' }));
  await drain(live, upserting, { env: { ...ENV, EGC_MESSAGING_DRY_RUN: 'false' } });
  assert.deepEqual([upserting.calls[0].path, upserting.calls[0].body.source, upserting.creates()[0].body.source], ['/contacts/upsert', 'Door to door', 'Door to door']);
});

test('door to door: a refused source never costs the customer their deal; any other refusal fails the attempt as before', async () => {
  const store = memory(REPS), ghl = fakeHighLevel({ fail: call => call.method === 'POST' && call.path === '/opportunities/' && 'source' in call.body ? { status: 422, body: { statusCode: 422, message: ['property source should not exist'] } } : 0 });
  await save(store, 'job-d2d', d2dSale());
  assert.equal((await drain(store, ghl)).done, 1);
  const [refused, plain] = ghl.creates();
  assert.deepEqual([refused.body.source, 'source' in plain.body, refused.headers['Idempotency-Key'], plain.headers['Idempotency-Key']], ['Door to door', false, 'egc-schedule-mirror:project_d2d-sale', 'egc-schedule-mirror:project_d2d-sale:plain']);
  assert.deepEqual({ ...plain.body, source: 'Door to door' }, refused.body, 'the same deal, only without the source');
  assert.deepEqual([store.entries()[0].steps.opportunity, store.entries()[0].steps.opportunityId, store.entries()[0].steps.opportunitySource, ghl.notes().length, ghl.deals.size], ['created', 'opp-new-1', 'refused', 1, 1]);
  const other = memory(REPS), refusing = fakeHighLevel({ fail: call => call.method === 'POST' && call.path === '/opportunities/' ? { status: 422, body: { message: ['contactId must be a string'] } } : 0 });
  await save(other, 'job-d2d', d2dSale());
  const failed = await drain(other, refusing);
  assert.deepEqual([failed.retrying, refusing.creates().length, other.entries()[0].lastError, refusing.notes().length], [1, 1, 'highlevel_422', 0]);
  // A job that is not door to door never sends a source, so its refused create is never re-sent.
  const plainJob = memory(REPS), plainRefused = fakeHighLevel({ fail: call => call.method === 'POST' && call.path === '/opportunities/' ? { status: 422, body: { message: ['property source should not exist'] } } : 0 });
  await save(plainJob, 'job-1', job());
  await drain(plainJob, plainRefused);
  assert.deepEqual([plainRefused.creates().length, 'source' in plainRefused.creates()[0].body, plainJob.entries()[0].lastError], [1, false, 'highlevel_422']);
});

test('EGC_GHL_D2D_TAGS: a door-to-door job\'s own tag only with the flag, once with its booking, never for a visit cancelled first; off, the same requests without it', async () => {
  for (const value of [undefined, '', 'TRUE', '1', 'yes', 'on']) assert.equal(ghlD2dTagsEnabled({ EGC_GHL_D2D_TAGS: value }), false, String(value));
  assert.equal(ghlD2dTagsEnabled({ EGC_GHL_D2D_TAGS: 'true' }), true);
  const requestId = randomUUID();
  const run = async (env, visit = d2dSale({ ghlTags: ['egc-hub-scheduled', 'egc-d2d-sale'] }), id = 'job-d2d') => { const store = memory(REPS), ghl = fakeHighLevel(); await save(store, id, visit, { requestId }); await drain(store, ghl, { env }); return { store, ghl }; };
  const on = await run(D2D_ENV), off = await run(ENV);
  assert.deepEqual(on.ghl.lines(), ['GET /opportunities/pipelines', 'GET /opportunities/search', 'POST /opportunities/', 'POST /contacts/contact-1/notes', 'POST /contacts/contact-1/tags']);
  assert.deepEqual(on.ghl.tags()[0].body, { tags: ['egc-d2d-sale'] }, 'only the D2D tag the job carries');
  assert.deepEqual([on.store.entries()[0].status, on.store.entries()[0].steps.tags], ['done', ['egc-d2d-sale']]);
  assert.deepEqual(off.ghl.calls, on.ghl.calls.slice(0, -1), 'flag off: the same requests, byte for byte, without the tag');
  assert.equal('tags' in off.store.entries()[0].steps, false);
  // A job that is not door to door: the flag changes nothing, and nothing carries a source.
  for (const visit of [job(), job({ ghlTags: ['egc-d2d-sale'] }), walkthrough()]) {
    const [withFlag, without] = [await run(D2D_ENV, visit, 'visit-1'), await run(ENV, visit, 'visit-1')];
    assert.deepEqual(withFlag.ghl.calls, without.ghl.calls);
    assert.equal(withFlag.ghl.calls.some(call => call.path.endsWith('/tags') || call.body?.source !== undefined || /Door to door/.test(call.body?.body || '')), false);
  }
  // Once: a move and a crew change add no tag again (each still gets its note).
  const once = memory(REPS), ghl = fakeHighLevel(), movedSale = d2dSale({ date: '2026-10-23', endDate: '2026-10-23' });
  await save(once, 'job-d2d', d2dSale());
  await drain(once, ghl, { env: D2D_ENV });
  await save(once, 'job-d2d', movedSale, { before: d2dSale(), at: later(1) });
  await save(once, 'job-d2d', { ...movedSale, assignedCrew: ['eli'] }, { before: movedSale, at: later(2) });
  await drain(once, ghl, { env: D2D_ENV, now: later(3), limit: 5 });
  assert.deepEqual([ghl.tags().length, ghl.notes().length, once.entries().map(entry => entry.kind).sort()], [1, 3, ['crew_assigned', 'rescheduled', 'scheduled']]);
  // Cancelled before HighLevel heard of it: the booking's note is told, no tag; a restore is a booking again.
  const cancelled = memory(REPS), quiet = fakeHighLevel(), gone = d2dSale({ status: 'cancelled', pipelineStatus: 'cancelled' });
  await save(cancelled, 'job-d2d', d2dSale());
  cancelled.rows.set('jobs/job-d2d', { ...cancelled.rows.get('jobs/job-d2d'), status: 'cancelled', pipelineStatus: 'cancelled', revision: 'cancelled' });
  await drain(cancelled, quiet, { env: D2D_ENV });
  assert.deepEqual([quiet.notes().length, quiet.tags().length, cancelled.entries()[0].superseded], [1, 0, true]);
  await save(cancelled, 'job-d2d', d2dSale(), { before: gone, action: 'schedule.restore', at: later(1) });
  await drain(cancelled, quiet, { env: D2D_ENV, now: later(2) });
  assert.deepEqual([quiet.tags().length, quiet.tags()[0].body.tags], [1, ['egc-d2d-sale']]);
  // A failed tag request retries the tag alone: one deal, one note.
  const flaky = memory(REPS), once503 = fakeHighLevel({ fail: call => call.path.endsWith('/tags') && once503.tags().length === 1 ? 503 : 0 });
  await save(flaky, 'job-d2d', d2dSale());
  const first = await drain(flaky, once503, { env: D2D_ENV });
  assert.deepEqual([first.retrying, flaky.entries()[0].lastError, Boolean(flaky.entries()[0].steps.note), 'tags' in flaky.entries()[0].steps], [1, 'highlevel_503', true, false]);
  await drain(flaky, once503, { env: D2D_ENV, now: later(1) });
  assert.deepEqual([flaky.entries()[0].status, once503.creates().length, once503.notes().length, once503.tags().length], ['done', 1, 1, 2]);
  // A deal that needs a person in HighLevel still gets the contact's tag once; the Retry that finishes the stage adds none.
  const parked = memory(REPS), two = fakeHighLevel({ opportunities: twoOpenDeals() });
  await save(parked, 'job-d2d', d2dSale());
  await drain(parked, two, { env: D2D_ENV });
  assert.deepEqual([parked.entries()[0].status, two.tags().length], ['parked', 1]);
  two.deals.get('opp-b').status = 'lost';
  const retried = await retryScheduleMirror(parked, owner, { action: 'retry', requestId: randomUUID() }, later(5), {});
  await drain(parked, two, { env: D2D_ENV, now: later(5), ids: retried.ids });
  assert.deepEqual([parked.entries()[0].status, parked.entries()[0].steps.opportunity, two.tags().length, two.notes().length], ['done', 'moved', 1, 1]);
});

test('a real Knock bridge sale reaches HighLevel as a door-to-door deal: "Door to door" contact and deal, the rep\'s note line and, with the flag, its tag', async () => {
  const w = await bridgeWorld({ env: { EGC_GHL_SCHEDULE_MIRROR: 'true' } });
  const { saleId, events } = saleBatch({ sale: { zip: '80528', city: 'Fort Collins', slot: { date: MON, time: '09:30', crewLabel: 'Crew 1' } } });
  assert.equal((await w.send(events)).status, 200);
  const booked = await w.book('sale', saleId);
  assert.equal(booked.body.booking.status, 'booked', JSON.stringify(booked.body));
  const [visit] = w.docs('jobs/').filter(row => row.type === 'job'), entries = w.docs(`${GHL_SCHEDULE_MIRROR}/`);
  assert.deepEqual([visit.source, visit.ghlTags, visit.d2d.kind, visit.d2d.repKey], ['door_to_door', ['egc-d2d-sale'], 'sale', 'rep.one']);
  assert.deepEqual(entries.map(entry => [entry.jobId, entry.kind, entry.stage]), [[visit.path.split('/').pop(), 'scheduled', 'job_scheduled']], 'the bridge\'s dispatch save queued the mirror in its commit');
  const ghl = fakeHighLevel(), env = { ...w.env, ...D2D_ENV, EGC_MESSAGING_DRY_RUN: 'false' };
  const summary = await drainScheduleMirror(scheduleMirrorStorage(env, w.fake.fetcher), { env, now: iso(BRIDGE_NOW + 2 * MIN), ids: entries.map(entry => entry.path.split('/').pop()), fetcher: ghl.fetcher });
  assert.equal(summary.done, 1, JSON.stringify(summary));
  assert.deepEqual(ghl.lines(), ['POST /contacts/upsert', 'GET /opportunities/pipelines', 'GET /opportunities/search', 'POST /opportunities/', 'POST /contacts/contact-new/notes', 'POST /contacts/contact-new/tags']);
  assert.deepEqual([ghl.calls[0].body.source, ghl.calls[0].body.name], ['Door to door', 'Pat Synthetic 2900']);
  assert.deepEqual([ghl.creates()[0].body.source, ghl.creates()[0].body.pipelineStageId], ['Door to door', EGC_JOB_SCHEDULED_STAGE]);
  assert.deepEqual(noteLines(ghl)[0].slice(0, 2), ['EGC SCHEDULE UPDATE: Job scheduled', 'Door to door: sale set by Rep']);
  assert.match(noteLines(ghl)[0].join('\n'), /Crew: Crew 1: /);
  assert.deepEqual(ghl.tags()[0].body, { tags: ['egc-d2d-sale'] });
  const done = w.fake.get(entries[0].path);
  assert.deepEqual([done.status, done.steps.opportunitySource, done.steps.tags], ['done', 'set', ['egc-d2d-sale']]);
});
