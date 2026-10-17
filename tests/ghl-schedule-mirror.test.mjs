// D9/D9b: the HighLevel schedule mirror (EGC_GHL_SCHEDULE_MIRROR). A Hub schedule change commits one ghlScheduleMirror
// entry with it; the drain upserts nothing but the linked contact (outside a dry run it may upsert one), keeps ONE
// opportunity per customer job in the EGC Pipeline moving forward only (Walkthrough Appointment, Job Scheduled), and
// writes one internal note per change. It never depends on a calendar: a deleted or missing calendar is "calendar mirror
// skipped", never a failure. A fake HighLevel records every request. Synthetic data, fixed clock, no network.
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
import { GHL_MIRROR_PARK_ATTEMPTS, GHL_SCHEDULE_MIRROR, GHL_SCHEDULE_MIRROR_LINKS, drainScheduleMirror, firstScheduleMirrorAttempt, ghlScheduleMirrorEnabled, retryScheduleMirror,
  scheduleMirrorChangeKey, scheduleMirrorEntryId, scheduleMirrorEvent, scheduleMirrorIds, scheduleMirrorLinkId, scheduleMirrorStatus, scheduleMirrorWrites } from '../functions/_lib/ghl-schedule-mirror.js';
import { EGC_JOB_SCHEDULED_STAGE, EGC_PIPELINE, EGC_WALKTHROUGH_APPOINTMENT_STAGE, schedulePipeline } from '../functions/_lib/highlevel-pipeline.js';
import { EGC_JOB_CALENDAR, EGC_LOCATION, EGC_WALKTHROUGH_CALENDAR, calendarDeletedAnswer, customerCalendars } from '../functions/_lib/highlevel-calendars.js';
import { estimatorHighLevelUserId, walkthroughEstimator } from '../functions/_lib/highlevel-users.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { chooseScheduleCalendar } from '../egc-platform/apps/api/src/schedule-calendar.ts';
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
    if (path === '/opportunities/search') { const contact = parsed.searchParams.get('contactId'), rows = [...deals.values()].filter(row => row.contactId === contact && row.status === 'open'); return json({ opportunities: rows, meta: { total: rows.length } }); }
    if (path === '/opportunities/upsert') { const id = `opp-new-${++n}`; deals.set(id, { id, ...body }); return json({ opportunity: { id } }); }
    const match = /^\/opportunities\/([^/]+)$/.exec(path);
    if (match) { const deal = deals.get(match[1]); if (!deal) return json({ message: 'Not found' }, 404); if (method === 'PUT') Object.assign(deal, body); return json({ opportunity: deal }); }
    if (/^\/contacts\/[^/]+\/notes$/.test(path)) return json({ note: { id: `note-${calls.length}` } });
    if (path === '/contacts/upsert') return json({ contact: { id: 'contact-new' } });
    return json({}, 404);
  }
  return { calls, deals, fetcher, lines: () => calls.map(call => `${call.method} ${call.path}`), writes: () => calls.filter(call => call.method !== 'GET'), notes: () => calls.filter(call => call.path.endsWith('/notes')) };
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
  assert.deepEqual(ghl.lines(), ['GET /opportunities/pipelines', 'GET /opportunities/search', 'POST /opportunities/upsert', 'POST /contacts/contact-1/notes']);
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
  assert.deepEqual([ghl.calls[2].body.pipelineStageId, ghl.calls[2].body.status, ghl.calls[2].body.pipelineId], [EGC_JOB_SCHEDULED_STAGE, 'open', EGC_PIPELINE]);
  assert.equal('assignedTo' in ghl.calls[2].body, false, 'a job move never reassigns the deal');
  assert.equal(ghl.deals.size, 1);
  assert.equal(ghl.calls.some(call => /tags|appointments|conversations/.test(call.path)), false, 'no tag, appointment or message');
});

test('never moves backwards: a later-stage, closed or same-stage deal is left alone, and the note is still written', async () => {
  for (const [deal, outcome] of [[{ pipelineStageId: 'paid-in-full', status: 'open' }, 'later_stage'], [{ pipelineStageId: 'walkthrough-complete', status: 'open' }, 'later_stage'],
    [{ pipelineStageId: EGC_WALKTHROUGH_APPOINTMENT_STAGE, status: 'open' }, 'at_stage'], [{ pipelineStageId: 'new-lead', status: 'won' }, 'closed'], [{ pipelineStageId: 'unknown-stage', status: 'open' }, 'stage_unknown']]) {
    const store = memory(), ghl = fakeHighLevel({ opportunities: [{ id: 'opp-1', contactId: 'contact-1', pipelineId: EGC_PIPELINE, name: 'Synthetic deal', monetaryValue: 1400, ...deal }] });
    await save(store, 'walk-1', walkthrough({ highlevelOpportunityId: 'opp-1' }));
    await drain(store, ghl);
    assert.equal(ghl.calls.some(call => call.method === 'PUT' || call.path === '/opportunities/upsert'), false, outcome);
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

test('idempotent per change: a replayed commit is refused, a done entry is never told twice, and concurrent drains write once', async () => {
  const store = memory(), ghl = fakeHighLevel();
  const { requestId } = await save(store, 'walk-1', walkthrough());
  const again = await scheduleMirrorWrites(store, { jobId: 'walk-1', after: walkthrough(), action: 'schedule.create', requestId, now: NOW });
  await assert.rejects(store.commit(again), /Conflict/, 'the same change key names the same entry, created once');
  const results = await Promise.all([drain(store, ghl), drain(store, ghl), drain(store, ghl, { ids: store.entries().map(entry => entry.id) })]);
  assert.equal(results.reduce((sum, row) => sum + row.done, 0), 1);
  assert.equal(ghl.notes().length, 1);
  assert.equal(ghl.calls.filter(call => call.path === '/opportunities/upsert').length, 1);
  assert.equal((await drain(store, ghl, { now: later(60) })).attempted, 0);
  assert.equal(ghl.notes().length, 1);
  // A note that failed after the deal was created retries the note only.
  const second = memory(), flaky = fakeHighLevel({ fail: call => call.path.endsWith('/notes') && flaky.notes().length === 1 ? 503 : 0 });
  await save(second, 'walk-2', walkthrough({ projectId: 'project_walk-2' }));
  const failed = await drain(second, flaky);
  assert.deepEqual([failed.retrying, second.entries()[0].steps.opportunity, second.entries()[0].lastError, second.entries()[0].nextAttemptAt], [1, 'created', 'highlevel_503', later(1)]);
  await drain(second, flaky, { now: later(1) });
  assert.deepEqual([second.entries()[0].status, flaky.calls.filter(call => call.path === '/opportunities/upsert').length, flaky.notes().length], ['done', 1, 2]);
});

test('a change the visit moved past is closed with no request; each change still gets its own note', async () => {
  const store = memory(), ghl = fakeHighLevel();
  await save(store, 'walk-1', walkthrough());
  await save(store, 'walk-1', walkthrough({ time: '11:00', endTime: '12:00' }), { before: walkthrough() });
  await save(store, 'walk-1', walkthrough({ time: '11:00', endTime: '12:00', assignedCrew: ['eli'] }), { before: walkthrough({ time: '11:00', endTime: '12:00' }) });
  const summary = await drain(store, ghl, { limit: 5 });
  assert.deepEqual([summary.skipped, summary.done], [2, 1]);
  const kinds = Object.fromEntries(store.entries().map(entry => [entry.kind, entry.skipped || entry.status]));
  assert.deepEqual(kinds, { scheduled: 'superseded', rescheduled: 'superseded', crew_assigned: 'done' });
  assert.equal(ghl.notes().length, 1);
  assert.match(ghl.notes()[0].body.body, /Estimator assigned[\s\S]*Time: 11:00 AM – 12:00 PM[\s\S]*Estimator: Eli Lead/);
});

test('several open deals for the customer are never guessed: the note is written and the entry parks; Retry finishes the stage', async () => {
  const deals = [{ id: 'opp-a', contactId: 'contact-1', pipelineId: EGC_PIPELINE, pipelineStageId: 'new-lead', status: 'open' }, { id: 'opp-b', contactId: 'contact-1', pipelineId: EGC_PIPELINE, pipelineStageId: 'new-lead', status: 'open' }];
  const store = memory(), ghl = fakeHighLevel({ opportunities: deals });
  await save(store, 'walk-1', walkthrough());
  const summary = await drain(store, ghl);
  assert.deepEqual([summary.parked, ghl.notes().length, ghl.calls.some(call => call.method === 'PUT' || call.path === '/opportunities/upsert')], [1, 1, false]);
  const [parked] = store.entries();
  assert.deepEqual([parked.status, parked.lastError, Boolean(parked.steps.note)], ['parked', 'ghl_mirror_opportunity_needs_link', true]);
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
  assert.deepEqual([summary.done, ghl.lines()], [1, ['GET /opportunities/pipelines', 'GET /opportunities/search', 'POST /opportunities/upsert', 'POST /contacts/contact-1/notes']]);
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
  assert.equal(ghl.calls.find(call => call.path === '/opportunities/upsert').body.assignedTo, 'GhlEstimator01');
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
  assert.deepEqual(upserting.lines(), ['POST /contacts/upsert', 'GET /opportunities/pipelines', 'GET /opportunities/search', 'POST /opportunities/upsert', 'POST /contacts/contact-new/notes']);
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

test('Integrations: the jobs calendar reads as optional, and the mirror reports its queue only with the flag on, counts only', async () => {
  const status = async (viewer, env, mirrorStatus) => (await (await integrationStatusHandlers({ session: async () => viewer, revocations: () => null, scheduleSync: async () => false, now: () => new Date(NOW), ...(mirrorStatus ? { mirrorStatus } : {}) })
    .get({ request: new Request(`${ORIGIN}/api/integration-status`), env })).json()).status;
  const off = await status(owner, { HIGHLEVEL_LOCATION_ID: EGC_LOCATION, HIGHLEVEL_JOB_CALENDAR_ID: 'new-jobs' }, () => assert.fail('flag off: nothing is read'));
  assert.equal(['ghlScheduleMirror', 'ghlScheduleMirrorState', 'highlevelJobCalendar'].some(key => key in off), false, 'flag off: the answer is unchanged');
  assert.equal((await status(owner, ENV, async () => ({ enabled: true }))).highlevelJobCalendar, false, 'no default jobs calendar any more');
  assert.equal((await status(owner, { ...ENV, HIGHLEVEL_JOB_CALENDAR_ID: 'new-jobs' }, async () => ({ enabled: true }))).highlevelJobCalendar, true);
  const queue = { enabled: true, parked: 2, needsLink: 1, overdue: 0, pending: 3, drain: { lastRunAt: NOW, minutesSince: 0, stale: false }, complete: true, asOf: NOW };
  const on = await status(owner, ENV, async () => queue);
  assert.deepEqual([on.ghlScheduleMirror, on.ghlScheduleMirrorState], [true, { ...queue, pipelineConfigured: true }]);
  const crewView = await status(crew, ENV, () => assert.fail('crew: the queue is not read'));
  assert.deepEqual([crewView.ghlScheduleMirror, 'ghlScheduleMirrorState' in crewView], [true, false]);
  const broken = await status(owner, ENV, async () => { throw new Error('unavailable'); });
  assert.equal(broken.ghlScheduleMirrorState.state, 'unavailable');
});

// The dispatch writer (functions/_lib/dispatch-service.js) queues the mirror through scheduleMirrorWrites next to the tag
// outbox, with dispatch-storage carrying the flag. This runs once that call site is merged; until then it is skipped.
const DISPATCH_WIRED = readFileSync(new URL('../functions/_lib/dispatch-service.js', import.meta.url), 'utf8').includes('scheduleMirrorWrites(store,');
test('dispatch saves queue the mirror in the same commit: book, assign a crew, move; a notes-only save queues nothing', { skip: DISPATCH_WIRED ? false : 'the dispatch-service call site is not merged yet' }, async () => {
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
  assert.deepEqual([summary.done, summary.skipped, ghl.notes().length], [1, 2, 1], 'only the change the visit still shows is told');
  assert.match(ghl.notes()[0].body.body, /Job rescheduled[\s\S]*Friday, October 23, 2026[\s\S]*Crew: Eli Lead, Jo Member/);
  store.ghlScheduleMirror = false;
  await mutate({ action: 'schedule.create', requestId: randomUUID(), customerId: 'c1', kind: 'walkthrough', changes: { date: '2026-10-24', time: '09:00', endTime: '10:00' } });
  assert.equal(store.entries().length, 3, 'flag off: dispatch writes no mirror entry');
});
