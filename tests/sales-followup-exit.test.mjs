import test from 'node:test';
import assert from 'node:assert/strict';
import { syncSalesFollowupExit, salesExitMilestone, salesExitService } from '../functions/_lib/sales-followup-exit.js';
import { encodeFirestoreFields, decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { onRequestPost } from '../functions/api/highlevel.js';
import { customerCalendars, EGC_JOB_CALENDAR, EGC_WALKTHROUGH_CALENDAR } from '../functions/_lib/highlevel-calendars.js';

const env = { FIREBASE_API_KEY: 'firebase-test-sales-exit', HIGHLEVEL_API_KEY: 'test-ghl', HIGHLEVEL_LOCATION_ID: 'location-1', HIGHLEVEL_JOB_CALENDAR_ID: 'service-calendar' };
const approved = { type: 'job', serviceType: 'Garage reset', customer: 'Test Customer', highlevelContactId: 'contact-1', highlevelOpportunityId: 'opp-1', phone: '(970) 555-0123', email: 'test@example.com', estimate: { status: 'accepted', acceptedAt: '2026-09-06T12:00:00Z', amount: 900 } };

async function fixture(run, options = {}) {
  let job = { ...approved, ...options.job }, revision = 1, ledger = null, ledgerRevision = 0, reads = 0;
  const signals = [], calls = [], original = globalThis.fetch;
  const version = () => `job-${revision}`;
  const document = (item, id) => ({ name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${id}`, fields: encodeFirestoreFields(item), updateTime: version() });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input), method = init.method || 'GET'; calls.push({ url, method, init });
    if (url.pathname.includes('/sales_handoffs/')) {
      if (method === 'PATCH') {
        if (ledger ? url.searchParams.get('currentDocument.updateTime') !== `ledger-${ledgerRevision}` : url.searchParams.get('currentDocument.exists') !== 'false') return new Response('{}', { status: 412 });
        ledger = decodeFirestoreFields(JSON.parse(init.body).fields); ledgerRevision++;
      }
      return ledger ? Response.json({ fields: encodeFirestoreFields(ledger), updateTime: `ledger-${ledgerRevision}` }) : new Response('{}', { status: 404 });
    }
    if (url.pathname.endsWith(':runQuery')) return Response.json((options.inventory || [{ ...job, id: 'job-1' }, ...(options.otherJobs || [])]).map(row => ({ document: document(row, row.id) })));
    if (url.hostname === 'firestore.googleapis.com') {
      if (method === 'PATCH') {
        if (url.searchParams.get('currentDocument.updateTime') !== version()) return new Response('{}', { status: 412 });
        job = { ...job, ...decodeFirestoreFields(JSON.parse(init.body).fields) }; revision++;
      } else if (++reads === 2 && options.changeBeforeSend) { job = { ...job, status: 'cancelled' }; revision++; }
      return Response.json(document(job, 'job-1'));
    }
    if (url.pathname === '/contacts/contact-1') return Response.json({ contact: { id: 'contact-1', locationId: 'location-1', phone: '+19705550123', email: 'test@example.com', ...options.contact } });
    if (url.pathname === '/opportunities/search') return Response.json({ opportunities: options.opportunities || [], meta: options.meta || {} });
    if (url.pathname.endsWith('/notes')) return Response.json({ note: { id: 'note-1' } });
    if (url.pathname.startsWith('/opportunities/')) return Response.json({ opportunity: { id: job.highlevelOpportunityId, contactId: 'contact-1', pipelineId: 'anSgrMpYHtAX6YlUHnIR', ...options.linkedOpportunity } });
    if (url.pathname.startsWith('/calendars/events/appointments/')) return Response.json({ id: 'appointment-1', calendarId: 'service-calendar', contactId: 'contact-1', appointmentStatus: 'confirmed', startTime: '2026-12-10T17:00:00Z', ...options.appointment });
    if (url.pathname.endsWith('/tags')) {
      signals.push(JSON.parse(init.body));
      if (options.signalThrows) throw new Error('Unknown provider result');
      if (options.signalStatus) return new Response('{}', { status: options.signalStatus });
      return Response.json({ tags: JSON.parse(init.body).tags });
    }
    throw new Error(`Unexpected call: ${method} ${url.pathname}`);
  };
  try { await run({ signals, calls, job: () => job, ledger: () => ledger, edit: patch => { job = { ...job, ...patch }; revision++; } }); } finally { globalThis.fetch = original; }
}

test('accepted garage quote signals only its exact exit helper once, without customer communication', () => fixture(async ({ signals, calls }) => {
  assert.equal((await syncSalesFollowupExit(env, 'job-1')).status, 'signalled');
  assert.equal((await syncSalesFollowupExit(env, 'job-1')).status, 'signalled');
  assert.deepEqual(signals, [{ tags: ['egc-garage-sales-exit'] }]);
  assert.equal(calls.some(call => call.url.pathname.includes('/messages') || call.url.pathname.includes('/tasks')), false);
  const search = calls.find(call => call.url.pathname === '/opportunities/search');
  assert.equal(search.url.searchParams.get('contactId'), 'contact-1');
}));

test('junk exits only junk sales; DND and notification preference do not keep sales running', () => fixture(async ({ signals }) => {
  assert.equal((await syncSalesFollowupExit(env, 'job-1')).status, 'signalled');
  assert.deepEqual(signals, [{ tags: ['egc-junk-sales-exit'] }]);
}, { job: { serviceType: 'Curbside junk pickup', notify: false }, contact: { dnd: true } }));

test('walkthrough, unpaid draft, cancelled job, and unknown mixed services cannot signal exits', async () => {
  for (const job of [{ type: 'walkthrough' }, { estimate: { status: 'draft' } }, { status: 'cancelled' }, { serviceType: 'Garage and junk' }, { serviceType: '' }, { estimate: { status: 'draft', amount: 1500 }, customerApproval: { status: 'superseded' }, acceptance: { signatureCaptured: true, acceptedAt: '2026-08-01' } }]) await fixture(async ({ signals }) => {
    assert.notEqual((await syncSalesFollowupExit(env, 'job-1')).status, 'signalled'); assert.equal(signals.length, 0);
  }, { job });
});

test('missing or mismatched saved customer identity fails closed', async () => {
  for (const options of [{ job: { highlevelContactId: '' } }, { job: { highlevelOpportunityId: '' } }, { linkedOpportunity: { contactId: 'other-contact' } }, { linkedOpportunity: { pipelineId: 'other-pipeline' } }, { contact: { locationId: 'different-location' } }, { contact: { phone: '+15555555555', email: 'other@example.com' } }]) await fixture(async ({ signals }) => {
    assert.equal((await syncSalesFollowupExit(env, 'job-1')).status, 'needs_review'); assert.equal(signals.length, 0);
  }, options);
});

test('second active same-customer job blocks contact-scoped cleanup even before CRM linking', () => fixture(async ({ signals }) => {
  assert.equal((await syncSalesFollowupExit(env, 'job-1')).reason, 'another_customer_job_active'); assert.equal(signals.length, 0);
}, { otherJobs: [{ id: 'job-2', type: 'job', phone: '+19705550123', serviceType: 'Garage clean', status: 'quoted' }] }));

test('converted source walkthrough and completed prior job do not block the matching job', () => fixture(async ({ signals }) => {
  assert.equal((await syncSalesFollowupExit(env, 'job-1')).status, 'signalled'); assert.equal(signals.length, 1);
}, { job: { sourceWalkthroughId: 'walk-1' }, otherJobs: [{ id: 'walk-1', type: 'walkthrough', highlevelContactId: 'contact-1' }, { id: 'old-job', type: 'job', status: 'completed', phone: '+19705550123' }] }));

test('second opportunity, foreign linkage, incomplete query, and foreign contact block cleanup', async () => {
  const opportunity = { id: 'opp-1', contactId: 'contact-1' };
  for (const options of [{ opportunities: [opportunity, { ...opportunity, id: 'opp-2' }] }, { job: { highlevelOpportunityId: 'opp-2' }, opportunities: [opportunity] }, { opportunities: [opportunity], meta: { total: 2 } }, { opportunities: [{ ...opportunity, contactId: 'someone-else' }] }]) await fixture(async ({ signals }) => {
    assert.equal((await syncSalesFollowupExit(env, 'job-1')).status, 'needs_review'); assert.equal(signals.length, 0);
  }, options);
});

test('saturated job inventory cannot be treated as complete', () => fixture(async ({ signals }) => {
  assert.equal((await syncSalesFollowupExit(env, 'job-1')).status, 'needs_review'); assert.equal(signals.length, 0);
}, { inventory: Array.from({ length: 501 }, (_, i) => ({ id: `job-${i}`, type: 'blocked' })) }));

test('confirmed service booking verifies calendar, customer and Denver time including winter DST offset', async () => {
  const job = { estimate: { status: 'draft' }, highlevelAppointmentId: 'appointment-1', status: 'scheduled', date: '2026-12-10', time: '10:00', endTime: '12:00' };
  await fixture(async ({ signals }) => { assert.equal((await syncSalesFollowupExit(env, 'job-1')).status, 'signalled'); assert.equal(signals.length, 1); }, { job });
  for (const appointment of [{ calendarId: '2yYX63nHYvUsL6KKhAc0' }, { contactId: 'other' }, { appointmentStatus: 'new' }, { startTime: '2026-12-10T18:00:00Z' }]) await fixture(async ({ signals }) => {
    assert.equal((await syncSalesFollowupExit(env, 'job-1')).status, 'needs_review'); assert.equal(signals.length, 0);
  }, { job, appointment });
});

test('saved closeout is a milestone but a naked completed status is not', () => {
  assert.equal(salesExitMilestone({ type: 'job', status: 'completed' }), '');
  assert.equal(salesExitMilestone({ type: 'job', status: 'completed', completedAt: '2026-09-06T20:00:00Z' }), 'completed');
  assert.equal(salesExitService({ serviceType: 'Garage service' }), 'garage');
});

test('job change between verification and dispatch prevents stale cleanup', () => fixture(async ({ signals }) => {
  assert.equal((await syncSalesFollowupExit(env, 'job-1')).status, 'retry'); assert.equal(signals.length, 0);
}, { changeBeforeSend: true }));

test('concurrent requests produce one signal and unknown external results are never blindly retried', async () => {
  await fixture(async ({ signals }) => { await Promise.all([syncSalesFollowupExit(env, 'job-1'), syncSalesFollowupExit(env, 'job-1')]); assert.equal(signals.length, 1); });
  await fixture(async ({ signals }) => { assert.equal((await syncSalesFollowupExit(env, 'job-1')).status, 'uncertain'); await syncSalesFollowupExit(env, 'job-1'); assert.equal(signals.length, 1); }, { signalThrows: true });
});

test('known tag rejection remains retryable after a fresh verification', () => fixture(async ({ ledger, signals }) => {
  assert.equal((await syncSalesFollowupExit(env, 'job-1')).status, 'failed');
  assert.equal(ledger().status, 'failed');
  await syncSalesFollowupExit(env, 'job-1'); assert.equal(signals.length, 2);
}, { signalStatus: 429 }));

test('new accepted estimate revision is checked again instead of inheriting a stale handoff', () => fixture(async ({ signals, edit }) => {
  await syncSalesFollowupExit(env, 'job-1');
  edit({ estimate: { status: 'accepted', amount: 900, acceptedAt: '2026-09-06T13:00:00Z' } });
  await syncSalesFollowupExit(env, 'job-1'); assert.equal(signals.length, 1, 'reconfirming the same quote must not emit another signal');
  edit({ estimate: { status: 'draft', amount: 1500 }, customerApproval: { status: 'superseded' } });
  assert.equal((await syncSalesFollowupExit(env, 'job-1')).status, 'not_eligible');
  edit({ estimate: { status: 'accepted', revision: 1, amount: 1500, acceptedAt: '2026-09-07T12:00:00Z' }, customerApproval: { status: 'approved' } });
  assert.equal((await syncSalesFollowupExit(env, 'job-1')).status, 'signalled'); assert.equal(signals.length, 2);
}));

test('crew cannot use another saved job to trigger lifecycle cleanup or modify its CRM links', () => fixture(async ({ signals, calls }) => {
  const configured = { ...env, HUB_SESSION_SECRET: 'test-sales-crew', HUB_AUTH_USERS_JSON: JSON.stringify({ Crew: { displayName: 'Crew', role: 'crew', passwordHash: 'test' } }) };
  const cookie = (await createHubSessionCookie(configured, 'Crew')).split(';')[0];
  const response = await onRequestPost({ env: configured, request: new Request('https://easygaragecleaning.com/api/highlevel', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ tool: 'lifecycle', event: 'job-complete', job_id: 'job-1', highlevel_contact_id: 'contact-1' }) }) });
  assert.equal(response.status, 403); assert.equal(signals.length, 0);
  assert.equal(calls.some(call => call.url.hostname === 'services.leadconnectorhq.com'), false);
}, { job: { assignedCrew: ['Different Crew Member'] } }));

test('sales exit retry endpoint requires a manager session', async () => {
  const response = await onRequestPost({ env, request: new Request('https://easygaragecleaning.com/api/highlevel', { method: 'POST', body: JSON.stringify({ tool: 'sales_exit', job_id: 'job-1' }) }) });
  assert.equal(response.status, 401);
  const configured = { ...env, HUB_SESSION_SECRET: 'test-sales-auth', HUB_AUTH_USERS_JSON: JSON.stringify({ Crew: { displayName: 'Crew', role: 'crew', passwordHash: 'test' } }) };
  const cookie = (await createHubSessionCookie(configured, 'Crew')).split(';')[0];
  const denied = await onRequestPost({ env: configured, request: new Request('https://easygaragecleaning.com/api/highlevel', { method: 'POST', headers: { Cookie: cookie }, body: JSON.stringify({ tool: 'sales_exit', job_id: 'job-1' }) }) });
  assert.equal(denied.status, 403);
});

const managerEnv = { ...env, HUB_SESSION_SECRET: 'test-sales-manager', HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { displayName: 'Zac', role: 'owner', passwordHash: 'test' } }), HIGHLEVEL_WALKTHROUGH_CALENDAR_ID: 'walkthrough-calendar' };
const managerCookie = (await createHubSessionCookie(managerEnv, 'ZacB')).split(';')[0];
const handoffRequest = payload => new Request('https://easygaragecleaning.com/api/highlevel', { method: 'POST', headers: { Cookie: managerCookie }, body: JSON.stringify(payload) });

test('reserved sales-exit lifecycle names are rejected before any external side effect', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('No outbound request expected'); };
  try {
    for (const event of ['garage-sales-exit', 'Junk Sales Exit', ' Garage_Sales_Exit ']) {
      const response = await onRequestPost({ env: managerEnv, request: handoffRequest({ tool: 'lifecycle', event, highlevel_contact_id: 'contact-1' }) });
      assert.equal(response.status, 400);
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('verified EGC staff calendars supply defaults only for EGC and bypass public booking hours only for those IDs', async () => {
  assert.deepEqual(customerCalendars({ HIGHLEVEL_LOCATION_ID: 'other' }), { jobCalendarId: '', walkthroughCalendarId: '' });
  const egc = { ...managerEnv, HIGHLEVEL_LOCATION_ID: 'KlgLwRaQSPz5G1YXsmc6', HIGHLEVEL_JOB_CALENDAR_ID: '', HIGHLEVEL_WALKTHROUGH_CALENDAR_ID: '' };
  assert.deepEqual(customerCalendars(egc), { jobCalendarId: EGC_JOB_CALENDAR, walkthroughCalendarId: EGC_WALKTHROUGH_CALENDAR });
  const original = globalThis.fetch;
  try {
    for (const scenario of [{ type: 'job', id: EGC_JOB_CALENDAR }, { type: 'walkthrough', id: EGC_WALKTHROUGH_CALENDAR }, { type: 'job', override: 'configured-public-calendar', id: 'configured-public-calendar' }]) {
      let body;
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(input);
        if (url.pathname === '/calendars/events/appointments') { body = JSON.parse(init.body); return Response.json({ id: 'appointment-1' }); }
        if (url.pathname === '/calendars/events') return Response.json({ events: [] });
        return Response.json({});
      };
      const response = await onRequestPost({ env: egc, request: handoffRequest({ tool: 'schedule', event_type: scenario.type, calendar_id: scenario.override, start_time: '2026-09-10T16:00:00Z', end_time: '2026-09-10T18:00:00Z', silent_update: true, notify: false, client: { highlevel_contact_id: 'contact-1' } }) });
      assert.equal(response.status, 200); assert.equal(body.calendarId, scenario.id);
      assert.equal(body.ignoreFreeSlotValidation, scenario.override ? undefined : true);
      assert.equal(body.toNotify, false);
    }
  } finally { globalThis.fetch = original; }
});

test('resaving an accepted Game Plan never re-adds quote persuasion tags', () => fixture(async ({ signals }) => {
  const payload = { tool: 'game_plan', job_id: 'job-1', opportunity_id: 'opp-1', client: { name: 'Test Customer', highlevel_contact_id: 'contact-1' }, quote: { total: 900 } };
  for (let i = 0; i < 2; i++) assert.equal((await onRequestPost({ env: managerEnv, request: handoffRequest(payload) })).status, 200);
  assert.equal(signals.some(row => row.tags.includes('gc-quote-open') || row.tags.includes('egc-quote-ready')), false);
  assert.equal(signals.filter(row => row.tags.includes('egc-garage-sales-exit')).length, 1);
}));

test('valid saved acceptance still exits sales when an unrelated calendar operation fails', () => fixture(async ({ signals }) => {
  const payload = { tool: 'game_plan', job_id: 'job-1', opportunity_id: 'opp-1', client: { highlevel_contact_id: 'contact-1' }, quote: { total: 900, job_date: '2026-09-10', start_time: '10:00', end_time: '12:00' } };
  const response = await onRequestPost({ env: { ...managerEnv, HIGHLEVEL_JOB_CALENDAR_ID: '' }, request: handoffRequest(payload) }), result = await response.json();
  assert.equal(response.status, 502); assert.equal(result.salesFollowupExit.status, 'signalled');
  assert.equal(signals.filter(row => row.tags.includes('egc-garage-sales-exit')).length, 1);
}));

test('foreign or unlinked opportunities are never moved, and walkthrough booking never advances service stage', async () => {
  const original = globalThis.fetch;
  try {
    for (const scenario of ['foreign', 'unlinked', 'walkthrough', 'employee-calendar']) {
      const calls = [];
      globalThis.fetch = async (input, init = {}) => {
        const url = new URL(input); calls.push({ url, init });
        if (url.pathname === '/opportunities/opp-1') return Response.json({ opportunity: { id: 'opp-1', contactId: 'someone-else', pipelineId: 'anSgrMpYHtAX6YlUHnIR' } });
        if (url.pathname === '/opportunities/search') return Response.json({ opportunities: [{ id: 'opp-1', contactId: 'contact-1' }] });
        if (url.pathname === '/calendars/events/appointments') return Response.json({ id: 'appointment-1' });
        if (url.pathname === '/calendars/events') return Response.json({ events: [] });
        return Response.json({});
      };
      const payload = { tool: 'schedule', event_type: scenario === 'walkthrough' ? 'walkthrough' : 'job', opportunity_id: scenario === 'unlinked' ? '' : 'opp-1', start_time: '2026-09-10T16:00:00Z', end_time: '2026-09-10T18:00:00Z', client: { highlevel_contact_id: 'contact-1' }, ...(scenario === 'employee-calendar' ? { calendar_id: '2yYX63nHYvUsL6KKhAc0' } : {}) };
      const response = await onRequestPost({ env: managerEnv, request: handoffRequest(payload) });
      assert.equal(response.status, scenario === 'employee-calendar' ? 502 : 200);
      assert.equal(calls.some(call => call.url.pathname.startsWith('/opportunities/') && ['PUT', 'POST'].includes(call.init.method)), false);
      if (scenario === 'employee-calendar') assert.equal(calls.some(call => call.url.pathname === '/calendars/events/appointments'), false);
    }
  } finally { globalThis.fetch = original; }
});
