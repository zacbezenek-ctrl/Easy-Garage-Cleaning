/**
 * Real PostgreSQL integration tests. All fixtures are synthetic, every HTTP
 * request is intercepted, and destructive setup requires an explicit loopback
 * test database. Run against a migrated database with EGC_META_TEST=isolated.
 */
import test, {beforeEach, afterEach, after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const databaseUrl = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (process.env.EGC_META_TEST !== 'isolated' ||
    !['localhost', '127.0.0.1'].includes(databaseUrl.hostname) ||
    !['/egc_meta_test', '/egc_operations_test'].includes(databaseUrl.pathname) ||
    !['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) {
  throw new Error('Meta integration tests require EGC_META_TEST=isolated and an explicitly named loopback test database');
}

// Guard before importing any service code or opening any database connection.
const {getDb, schema} = await import('@egc/database');
const {eq, sql} = await import('drizzle-orm');
const {previewConversions, syncConversions, retryConversions, conversionStatus, sendTestEvent} = await import('../dist/index.js');
const db = getDb();
const originalFetch = globalThis.fetch;
const originalEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('META_CAPI_')));
const datasetId = '1262944809378035';
const syntheticToken = 'synthetic-test-token-never-a-real-credential';
const syntheticTestCode = 'TEST_EGC_ISOLATED';
const syntheticEmail = 'Synthetic.Customer@example.invalid';
const syntheticPhone = '+1 (303) 555-0123';
const sha256 = text => createHash('sha256').update(text).digest('hex');
const minutesAgo = n => new Date(Date.now() - n * 60_000);
const daysAgo = n => new Date(Date.now() - n * 86_400_000);
const accepted = () => Response.json({events_received: 1, messages: [], fbtrace_id: 'SYNTHETIC_TRACE'});
let requests = [];
let transportViolations = [];
let respond = async () => accepted();

globalThis.fetch = async (input, init) => {
  // There is deliberately no path to originalFetch, including for an unexpected URL.
  const requestUrl = new URL(String(input));
  if (requestUrl.origin !== 'https://graph.facebook.com' ||
      !new RegExp(`^/v[0-9]+\\.0/${datasetId}/events$`).test(requestUrl.pathname) ||
      requestUrl.search || init?.method !== 'POST') {
    transportViolations.push('Unexpected external destination or HTTP request shape');
    throw new Error('External HTTP disabled by isolated integration test');
  }
  const headers = new Headers(init.headers);
  if (headers.get('authorization') !== `Bearer ${syntheticToken}`) transportViolations.push('Unexpected authorization header');
  const body = JSON.parse(String(init.body));
  if (!Array.isArray(body.data) || body.data.length !== 1) transportViolations.push('Expected one independently acknowledged event');
  requests.push(structuredClone(body));
  return respond(body, init);
};

const eventRows = () => db.select().from(schema.metaConversionEvents);
const attemptRows = () => db.select().from(schema.metaConversionAttempts);
const productionRequests = () => requests.filter(request => !request.test_event_code);
const sync = (extra = {}) => syncConversions({days: 7, limit: 100, dryRun: false, ...extra});
const retry = (extra = {}) => retryConversions({days: 7, limit: 100, dryRun: false, ...extra});

async function countLedgerRows() {
  const [row] = await db.execute(sql`
    SELECT (SELECT count(*) FROM meta_conversion_events)::int AS events,
           (SELECT count(*) FROM meta_conversion_attempts)::int AS attempts,
           (SELECT count(*) FROM meta_conversion_runs)::int AS runs,
           (SELECT count(*) FROM meta_conversion_tests)::int AS tests`);
  return row;
}

async function seedLead({source = 'Facebook', email = syntheticEmail, phone = syntheticPhone, attribution, createdAt = daysAgo(2)} = {}) {
  const [contact] = await db.insert(schema.contacts).values({
    provider: 'ghl', providerId: `synthetic-${randomUUID()}`, source, email, phone,
    providerCreatedAt: createdAt, createdAt,
    raw: {attributionSource: attribution ?? {source, adId: '120253868777650385', campaignId: '120253712240240385', sessionSource: 'Paid Social'}}
  }).returning();
  const [lead] = await db.insert(schema.leads).values({contactId: contact.id, source, createdAt}).returning();
  return {contact, lead};
}

async function seedWalkthrough(options = {}) {
  const fixture = await seedLead(options);
  const bookedAt = options.bookedAt ?? minutesAgo(10);
  const [appointment] = await db.insert(schema.appointments).values({
    providerId: `synthetic-appointment-${randomUUID()}`, contactId: fixture.contact.id,
    calendarId: options.calendarId ?? 'synthetic-walkthrough-calendar',
    title: 'Synthetic garage walkthrough', status: options.status ?? 'confirmed',
    appointmentCreatedAt: bookedAt, appointmentStartAt: new Date(Date.now() + 86_400_000)
  }).returning();
  await db.update(schema.leads).set({currentState: 'BOOKED', firstBookedAt: bookedAt}).where(eq(schema.leads.id, fixture.lead.id));
  return {...fixture, appointment};
}

async function seedWonOpportunity(fixture, valueCents = 190000) {
  const [opportunity] = await db.insert(schema.opportunities).values({
    providerId: `synthetic-opportunity-${randomUUID()}`, contactId: fixture.contact.id,
    status: 'open', monetaryValueCents: valueCents
  }).returning();
  const [won] = await db.update(schema.opportunities).set({status: 'won'}).where(eq(schema.opportunities.id, opportunity.id)).returning();
  return won;
}

async function enableProduction() {
  process.env.META_CAPI_MODE = 'production';
  await sendTestEvent();
  const tests = await db.select().from(schema.metaConversionTests);
  assert.equal(tests.length, 1);
  assert.equal(tests[0].accepted, true, 'Production fixture requires a genuinely accepted fake Test Events request');
  requests = [];
}

async function makeRetryDue(id) {
  await db.update(schema.metaConversionEvents).set({nextAttemptAt: minutesAgo(1)}).where(eq(schema.metaConversionEvents.id, id));
}

beforeEach(async () => {
  for (const key of Object.keys(process.env)) if (key.startsWith('META_CAPI_')) delete process.env[key];
  Object.assign(process.env, {
    META_CAPI_MODE: 'shadow', META_CAPI_DATASET_ID: datasetId, META_CAPI_DATASET_VERIFIED_ID: datasetId,
    META_CAPI_ACCESS_TOKEN: syntheticToken, META_CAPI_TEST_EVENT_CODE: syntheticTestCode,
    META_CAPI_START_AT: daysAgo(1).toISOString(), META_CAPI_FUNNEL_VERIFIED: 'true',
    META_CAPI_WALKTHROUGH_CALENDAR_IDS: 'synthetic-walkthrough-calendar',
    META_CAPI_JOB_CALENDAR_IDS: 'synthetic-job-calendar'
  });
  requests = []; transportViolations = []; respond = async () => accepted();
  await db.execute(sql`TRUNCATE meta_conversion_attempts, meta_conversion_events, meta_conversion_runs, meta_conversion_tests,
    appointments, calls, conversations, jobs, leads, messages, opportunities, walkthroughs, tasks,
    call_transcripts, job_notes, contacts, sync_cursors RESTART IDENTITY CASCADE`);
  await db.insert(schema.syncCursors).values([
    {key: 'meta.conversions.job_calendar_ids', cursor: JSON.stringify(['synthetic-job-calendar'])},
    {key: 'meta.conversions.walkthrough_calendar_ids', cursor: JSON.stringify(['synthetic-walkthrough-calendar'])}
  ]);
});

afterEach(() => assert.deepEqual(transportViolations, [], 'No external HTTP or secret-bearing URL is permitted'));
after(async () => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (key.startsWith('META_CAPI_')) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  await db.$client.end({timeout: 5});
});

test('preview, dry-run sync and status read real rows without touching ledger or HTTP', async () => {
  await seedWalkthrough();
  const before = await countLedgerRows();
  const preview = await previewConversions({days: 7, limit: 100});
  const dryRun = await sync({dryRun: true});
  const status = await conversionStatus({days: 30, limit: 100});
  assert.ok(JSON.stringify(preview).includes('WALKTHROUGH_BOOKED'));
  assert.ok(dryRun && status);
  assert.deepEqual(await countLedgerRows(), before);
  assert.equal(requests.length, 0);
  for (const result of [preview, dryRun, status]) {
    const text = JSON.stringify(result);
    for (const forbidden of [syntheticToken, syntheticTestCode, syntheticEmail, syntheticPhone, sha256(syntheticEmail.toLowerCase())]) {
      assert.ok(!text.includes(forbidden), 'Read responses must expose matching quality, not PII or matching hashes');
    }
  }
});

test('shadow reconciliation creates an auditable queue but cannot transmit', async () => {
  await seedWalkthrough();
  await sync();
  assert.equal(requests.length, 0);
  const rows = await eventRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].eventType, 'WALKTHROUGH_BOOKED');
  assert.equal(rows[0].attemptCount, 0);
  assert.equal((await attemptRows()).length, 0);
});

test('production remains blocked until an accepted test event for its own dataset exists', async () => {
  await seedWalkthrough();
  process.env.META_CAPI_MODE = 'production';
  await db.insert(schema.metaConversionTests).values({id: 'wrong-dataset-test', datasetId: '970332989051988', accepted: true, response: {eventsReceived: 1}});
  await sync();
  assert.equal(requests.length, 0);
  assert.ok((await eventRows()).every(row => row.attemptCount === 0));
});

test('each configuration gate is enforced before transmitting an already queued event', async () => {
  await seedWalkthrough();
  await enableProduction();
  const gates = {
    META_CAPI_MODE: 'shadow', META_CAPI_ACCESS_TOKEN: '', META_CAPI_DATASET_VERIFIED_ID: '',
    META_CAPI_FUNNEL_VERIFIED: 'false', META_CAPI_START_AT: '', META_CAPI_WALKTHROUGH_CALENDAR_IDS: ''
  };
  for (const [key, value] of Object.entries(gates)) {
    const previous = process.env[key];
    process.env[key] = value;
    const result = await sync();
    assert.equal(result.accepted, 0, `${key} gate must prevent sending`);
    assert.ok(result.productionBlockers.length > 0);
    assert.equal(productionRequests().length, 0);
    process.env[key] = previous;
  }
  assert.equal((await sync()).accepted, 1);
});

test('verified setup keeps running after seven days without requiring weekly manual test sends', async () => {
  await seedWalkthrough();
  await enableProduction();
  await db.update(schema.metaConversionTests).set({createdAt: daysAgo(30)});
  const result = await sync();
  assert.equal(result.accepted, 1);
  assert.equal(productionRequests().length, 1);
});

test('test events are synthetic and separately audited, with no production conversion consumed', async () => {
  await seedWalkthrough();
  await sendTestEvent();
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.test_event_code === syntheticTestCode));
  assert.deepEqual(requests.map(request => request.data[0].event_name).sort(), ['JOB_WON', 'WALKTHROUGH_BOOKED']);
  assert.ok(!JSON.stringify(requests[0]).includes(sha256(syntheticEmail.toLowerCase())));
  assert.equal((await eventRows()).length, 0);
  assert.equal((await db.select().from(schema.metaConversionTests))[0].accepted, true);
  process.env.META_CAPI_MODE = 'production';
  const firstSync = await sync();
  assert.equal(firstSync.accepted, 1);
  assert.equal(firstSync.failed, 0);
  assert.equal(productionRequests().length, 1);
  assert.equal((await eventRows())[0].status, 'accepted');
});

test('booked and won stages transmit once with actual revenue and immutable event identities', async () => {
  const fixture = await seedWalkthrough();
  const won = await seedWonOpportunity(fixture);
  assert.ok(won.wonAt instanceof Date, 'DB trigger must persist a real won transition');
  await enableProduction();
  const firstSync = await sync();
  assert.equal(firstSync.accepted, 2);
  assert.equal(firstSync.failed, 0);
  let rows = await eventRows();
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.status === 'accepted' && row.attemptCount === 1));
  const events = productionRequests().map(request => request.data[0]);
  assert.deepEqual(events.map(event => event.event_name).sort(), ['JOB_WON', 'WALKTHROUGH_BOOKED']);
  const purchase = events.find(event => event.event_name === 'JOB_WON');
  assert.equal(purchase.custom_data.value, 1900);
  assert.equal(purchase.custom_data.currency, 'USD');
  assert.ok(events.every(event => event.user_data.em[0] === sha256(syntheticEmail.toLowerCase())));
  assert.ok(events.every(event => event.user_data.ph[0] === sha256('13035550123')));
  assert.ok(events.every(event => event.action_source === 'system_generated' && event.custom_data.event_source === 'crm'));
  const before = structuredClone(rows);
  const secondSync = await sync();
  assert.equal(secondSync.accepted, 0);
  assert.equal(secondSync.alreadySynced, 2);
  await retry({eventIds: rows.map(row => row.id)});
  rows = await eventRows();
  assert.equal(productionRequests().length, 2);
  assert.deepEqual(rows.map(row => [row.id, row.payload, row.attemptCount]), before.map(row => [row.id, row.payload, row.attemptCount]));
  const status = await conversionStatus({days: 30});
  assert.equal(status.counts.accepted, 2);
  assert.equal(status.recentAccepted.length, 2);
  assert.equal(status.transmissions.wonValueCents, 190000);
  assert.equal(status.cohort.booked, 1);
  assert.equal(status.cohort.customers, 1);
});

test('won opportunity without reliable value sends the stage without invented revenue', async () => {
  const fixture = await seedLead();
  await seedWonOpportunity(fixture, null);
  await enableProduction();
  await sync();
  assert.equal(productionRequests().length, 1);
  const event = productionRequests()[0].data[0];
  assert.equal(event.event_name, 'JOB_WON');
  assert.equal(event.custom_data.value, undefined);
  assert.equal(event.custom_data.currency, undefined);
});

test('overlapping callers claim one committed lease and make only one network request', async () => {
  await seedWalkthrough();
  await enableProduction();
  let signalRequest;
  let releaseRequest;
  const requestStarted = new Promise(resolve => { signalRequest = resolve; });
  const requestReleased = new Promise(resolve => { releaseRequest = resolve; });
  respond = async () => { signalRequest(); await requestReleased; return accepted(); };
  const first = sync();
  try {
    await Promise.race([requestStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('Sender did not reach its request')), 5000).unref())]);
    const rowsDuringRequest = await eventRows();
    assert.equal(rowsDuringRequest.length, 1);
    assert.equal(rowsDuringRequest[0].attemptCount, 1, 'Claim must be committed before network IO');
    assert.equal((await attemptRows()).length, 1, 'Attempt must survive process failure during HTTP');
    await Promise.race([sync(), new Promise((_, reject) => setTimeout(() => reject(new Error('Concurrent caller blocked behind an HTTP-held transaction')), 5000).unref())]);
    assert.equal(productionRequests().length, 1);
  } finally {
    releaseRequest();
    await first;
  }
  assert.equal((await eventRows())[0].status, 'accepted');
});

test('retry after provider failure preserves the original payload despite contact edits', async () => {
  const fixture = await seedWalkthrough();
  await enableProduction();
  respond = async () => Response.json({error: {code: 2, is_transient: true, message: 'synthetic temporary failure'}}, {status: 503});
  await sync();
  const [failed] = await eventRows();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attemptCount, 1);
  const firstPayload = structuredClone(productionRequests()[0].data[0]);
  await db.update(schema.contacts).set({email: 'changed@example.invalid', phone: '+1 720 555 0199'}).where(eq(schema.contacts.id, fixture.contact.id));
  await makeRetryDue(failed.id);
  respond = async () => accepted();
  await retry({eventIds: [failed.id]});
  const [acceptedRow] = await eventRows();
  assert.equal(acceptedRow.status, 'accepted');
  assert.equal(acceptedRow.attemptCount, 2);
  assert.deepEqual(productionRequests()[1].data[0], firstPayload);
  assert.deepEqual(acceptedRow.payload, firstPayload);
  assert.deepEqual((await attemptRows()).map(row => row.attemptNumber).sort(), [1, 2]);
});

test('uncertain network outcomes retry with the same event ID and never become false acceptance', async () => {
  await seedWalkthrough();
  await enableProduction();
  respond = async () => { throw new Error(`connection reset ${syntheticToken} ${syntheticEmail}`); };
  await sync();
  const [failed] = await eventRows();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'meta_network_outcome_unknown');
  assert.equal(failed.acceptedAt, null);
  await makeRetryDue(failed.id);
  respond = async () => accepted();
  await retry({eventIds: [failed.id]});
  assert.equal((await eventRows())[0].status, 'accepted');
  assert.deepEqual(productionRequests()[1].data[0], productionRequests()[0].data[0]);
});

test('malformed successful HTTP response stays failed and stores only safe diagnostics', async () => {
  await seedWalkthrough();
  await enableProduction();
  respond = async () => new Response(`not-json ${syntheticToken} ${syntheticEmail}`, {status: 200});
  await sync();
  const [row] = await eventRows();
  assert.equal(row.status, 'failed');
  assert.equal(row.error, 'malformed_meta_response');
  assert.equal(row.acceptedAt, null);
  assert.ok(!JSON.stringify(await attemptRows()).includes(syntheticToken));
  assert.ok(!JSON.stringify(await conversionStatus({days: 30})).includes(syntheticEmail));
});

test('permanent Meta rejection is not retried and cannot echo secrets into the ledger', async () => {
  await seedWalkthrough();
  await enableProduction();
  respond = async () => Response.json({error: {code: 190, error_subcode: 463, message: `${syntheticToken} ${syntheticEmail}`}, messages: [syntheticPhone], fbtrace_id: syntheticToken}, {status: 400});
  await sync();
  const [row] = await eventRows();
  assert.equal(row.status, 'failed');
  assert.equal(row.retryable, false);
  await makeRetryDue(row.id);
  await retry({eventIds: [row.id]});
  assert.equal(productionRequests().length, 1);
  const persisted = JSON.stringify({events: await eventRows(), attempts: await attemptRows(), status: await conversionStatus({days: 30})});
  for (const forbidden of [syntheticToken, syntheticEmail, syntheticPhone]) assert.ok(!persisted.includes(forbidden));
});

test('a retry outside the deduplication safety window is retained for review without resending', async () => {
  await seedWalkthrough();
  await enableProduction();
  respond = async () => { throw new Error('synthetic interrupted acknowledgement'); };
  await sync();
  const [row] = await eventRows();
  await db.update(schema.metaConversionEvents).set({firstAttemptAt: daysAgo(2), nextAttemptAt: minutesAgo(1)}).where(eq(schema.metaConversionEvents.id, row.id));
  respond = async () => accepted();
  await retry({eventIds: [row.id]});
  assert.equal(productionRequests().length, 1);
  const [held] = await eventRows();
  assert.notEqual(held.status, 'accepted');
  assert.equal(held.retryable, false);
  assert.match(held.error, /deduplication_window/);
});

test('a live sender lease excludes competing callers and an expired lease recovers its original snapshot', async () => {
  await seedWalkthrough();
  await enableProduction();
  respond = async () => { throw new Error('synthetic process died during response'); };
  await sync();
  const [row] = await eventRows();
  await db.update(schema.metaConversionEvents).set({status: 'processing', leaseToken: 'synthetic-stale-worker', leaseUntil: new Date(Date.now() + 120_000), nextAttemptAt: null}).where(eq(schema.metaConversionEvents.id, row.id));
  await retry({eventIds: [row.id]});
  assert.equal(productionRequests().length, 1);
  await db.update(schema.metaConversionEvents).set({leaseUntil: minutesAgo(1)}).where(eq(schema.metaConversionEvents.id, row.id));
  respond = async () => accepted();
  await retry({eventIds: [row.id]});
  assert.equal(productionRequests().length, 2);
  assert.equal((await eventRows())[0].status, 'accepted');
  assert.deepEqual(productionRequests()[1].data[0], productionRequests()[0].data[0]);
});

async function raceExpiredLease(firstAccepted, replacementAccepted) {
  await seedWalkthrough();
  await enableProduction();
  let signalFirst;
  let releaseFirst;
  let requestCount = 0;
  const firstStarted = new Promise(resolve => { signalFirst = resolve; });
  const firstReleased = new Promise(resolve => { releaseFirst = resolve; });
  const rejected = () => Response.json({error: {code: 2, is_transient: true}}, {status: 503});
  respond = async () => {
    if (++requestCount === 1) {
      signalFirst();
      await firstReleased;
      return firstAccepted ? accepted() : rejected();
    }
    return replacementAccepted ? accepted() : rejected();
  };
  const first = sync();
  try {
    await Promise.race([firstStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('First sender did not reach HTTP')), 5000).unref())]);
    const [row] = await eventRows();
    await db.update(schema.metaConversionEvents).set({leaseUntil: minutesAgo(1)}).where(eq(schema.metaConversionEvents.id, row.id));
    await retry({eventIds: [row.id]});
    assert.equal(productionRequests().length, 2);
    assert.equal((await eventRows())[0].status, replacementAccepted ? 'accepted' : 'failed');
  } finally {
    releaseFirst();
    await first;
  }
  const [final] = await eventRows();
  assert.equal(final.status, 'accepted', 'Any confirmed acceptance is terminal despite lease ordering');
  assert.equal(final.attemptCount, 2);
  assert.ok(final.acceptedAt instanceof Date);
  assert.equal(final.retryable, false);
  assert.deepEqual(productionRequests()[0].data[0], productionRequests()[1].data[0]);
  await retry({eventIds: [final.id]});
  assert.equal(productionRequests().length, 2, 'Accepted event must never transmit again');
}

test('a delayed acceptance from an expired lease supersedes a newer failed attempt', async () => {
  await raceExpiredLease(true, false);
});

test('a delayed rejection from an expired lease cannot overwrite a newer acceptance', async () => {
  await raceExpiredLease(false, true);
});

test('attribution, matching, cancelled appointments and activation date exclude false conversions', async () => {
  await seedWalkthrough({source: 'Referral', attribution: {source: 'Referral'}});
  await seedWalkthrough({email: null, phone: null});
  await seedWalkthrough({status: 'cancelled'});
  await seedWalkthrough({bookedAt: daysAgo(3), createdAt: daysAgo(5)});
  await seedWalkthrough({bookedAt: daysAgo(8), createdAt: daysAgo(10)});
  await enableProduction();
  await sync();
  assert.equal(productionRequests().length, 0);
  assert.ok((await eventRows()).every(row => row.status !== 'accepted' && row.attemptCount === 0));
});

test('a scheduled job linked to a walkthrough is not a won customer', async () => {
  const fixture = await seedWalkthrough();
  const [job] = await db.insert(schema.jobs).values({contactId: fixture.contact.id, appointmentId: fixture.appointment.id, status: 'draft', serviceType: 'garage cleaning', priceCents: 190000}).returning();
  const [scheduled] = await db.update(schema.jobs).set({status: 'scheduled', scheduledAt: new Date(Date.now() + 86_400_000)}).where(eq(schema.jobs.id, job.id)).returning();
  assert.equal(scheduled.wonAt, null, 'Scheduling a walkthrough cannot establish a customer win timestamp');
  await enableProduction();
  await sync();
  assert.deepEqual(productionRequests().map(request => request.data[0].event_name), ['WALKTHROUGH_BOOKED']);
});

test('a real service appointment establishes a job win once and preserves its time through completion', async () => {
  const fixture = await seedWalkthrough({calendarId: 'synthetic-job-calendar'});
  const [job] = await db.insert(schema.jobs).values({contactId: fixture.contact.id, appointmentId: fixture.appointment.id, status: 'draft', priceCents: 190000}).returning();
  assert.equal(job.wonAt, null);
  const [scheduled] = await db.update(schema.jobs).set({status: 'scheduled', scheduledAt: new Date(Date.now() + 86_400_000)}).where(eq(schema.jobs.id, job.id)).returning();
  assert.ok(scheduled.wonAt instanceof Date);
  for (const status of ['confirmed', 'in_progress', 'completed']) {
    const [next] = await db.update(schema.jobs).set({status}).where(eq(schema.jobs.id, job.id)).returning();
    assert.equal(next.wonAt.toISOString(), scheduled.wonAt.toISOString());
  }
  await enableProduction();
  assert.equal((await sync()).accepted, 1);
  assert.equal(productionRequests()[0].data[0].event_name, 'JOB_WON');
});

test('a legacy scheduled job with unknown win time is not retimed on status progression', async () => {
  const fixture = await seedWalkthrough({calendarId: 'synthetic-job-calendar'});
  let legacy;
  // Simulate the pre-migration row shape. This table and database are isolated.
  await db.execute(sql`ALTER TABLE jobs DISABLE TRIGGER egc_job_win`);
  try {
    [legacy] = await db.insert(schema.jobs).values({contactId: fixture.contact.id, appointmentId: fixture.appointment.id, status: 'scheduled', scheduledAt: new Date(Date.now() + 86_400_000), priceCents: 190000}).returning();
  } finally {
    await db.execute(sql`ALTER TABLE jobs ENABLE TRIGGER egc_job_win`);
  }
  assert.equal(legacy.wonAt, null);
  for (const status of ['confirmed', 'in_progress', 'completed']) {
    const [next] = await db.update(schema.jobs).set({status}).where(eq(schema.jobs.id, legacy.id)).returning();
    assert.equal(next.wonAt, null, 'Progression cannot invent a historical win time');
  }
  await enableProduction();
  await sync();
  assert.equal(productionRequests().length, 0);
});

test('won timestamps survive routine edits and do not synthesize dates for historic imports', async () => {
  const fixture = await seedLead();
  const won = await seedWonOpportunity(fixture);
  assert.ok(won.wonAt instanceof Date);
  const [edited] = await db.update(schema.opportunities).set({monetaryValueCents: 200000, updatedAt: new Date()}).where(eq(schema.opportunities.id, won.id)).returning();
  assert.equal(edited.wonAt.toISOString(), won.wonAt.toISOString());
  const [imported] = await db.insert(schema.opportunities).values({providerId: `historical-${randomUUID()}`, contactId: fixture.contact.id, status: 'won', providerCreatedAt: daysAgo(90), providerUpdatedAt: daysAgo(30)}).returning();
  assert.equal(imported.wonAt, null, 'Initial won imports do not establish when conversion really happened');
  const [recentImport] = await db.insert(schema.opportunities).values({providerId: `recent-import-${randomUUID()}`, contactId: fixture.contact.id, status: 'won', providerCreatedAt: minutesAgo(1), providerUpdatedAt: minutesAgo(1)}).returning();
  assert.equal(recentImport.wonAt, null, 'Recent creation time is not an observed win timestamp either');
});

test('a trusted locally observed create-won operation preserves its explicit transition time', async () => {
  const fixture = await seedLead();
  const observedWonAt = minutesAgo(1);
  const [won] = await db.insert(schema.opportunities).values({
    providerId: `locally-observed-${randomUUID()}`, contactId: fixture.contact.id,
    status: 'won', wonAt: observedWonAt, monetaryValueCents: 190000
  }).returning();
  assert.equal(won.wonAt.toISOString(), observedWonAt.toISOString());
  await enableProduction();
  assert.equal((await sync()).accepted, 1);
  assert.equal(productionRequests()[0].data[0].event_time, Math.floor(observedWonAt.valueOf() / 1000));
});

test('database failures propagate without sending or falsely reporting an empty successful preview', async () => {
  await seedWalkthrough();
  await enableProduction();
  await db.execute(sql`ALTER TABLE meta_conversion_events RENAME TO meta_conversion_events_temporarily_unavailable`);
  try {
    await assert.rejects(previewConversions({days: 7}));
    await assert.rejects(sync());
    assert.equal(productionRequests().length, 0);
  } finally {
    await db.execute(sql`ALTER TABLE meta_conversion_events_temporarily_unavailable RENAME TO meta_conversion_events`);
  }
});

test('the destructive fixture guard refuses remote or production-named databases before importing services', () => {
  for (const url of ['postgres://synthetic@database.railway.internal/egc_meta_test', 'postgres://synthetic@127.0.0.1/railway']) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: {...process.env, EGC_META_TEST: 'isolated', DATABASE_URL: url}, encoding: 'utf8', timeout: 5000
    });
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /explicitly named loopback test database/);
    assert.ok(!child.stderr.includes(url), 'Guard diagnostics must not echo database credentials');
  }
});
