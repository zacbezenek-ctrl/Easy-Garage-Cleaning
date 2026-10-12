// "Create Hub job" from a door-to-door sale (Knock Admin > Sales): the Hub customer is found or created with the
// Hub's own customer resolution and ONE unscheduled job lands in Dispatch's To schedule queue through dispatch's own
// create, with Notify customer off and nothing sent. Real /api/knock-admin handler, the Knock and Dispatch stores on
// one Firestore REST fake, synthetic data, a fixed clock; any other network request is recorded and refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { knockSyncHandlers } from '../functions/api/knock-sync.js';
import { knockAdminHandlers } from '../functions/api/knock-admin.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { dispatchOverview } from '../functions/_lib/dispatch-service.js';
import { queueSource } from '../functions/_lib/dispatch-queue.js';
import { internalNote, openHubJobMessage, saleRequestId } from '../functions/_lib/knock-hub-job.js';
import { call, cookieFor, get, knockEnv, knockWorld, post, uuid } from './helpers/knock-fixture.mjs';

// Tuesday 2026-10-06, 11:00 am in Fort Collins.
const NOW = Date.parse('2026-10-06T17:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
const MIN = 60000;
const CHECKLIST = { contractSigned: true, noticesHanded: true, rightToCancelTold: true };

function seed(extra = {}) {
  return {
    'knock_neighborhoods/english-ranch': { name: 'English Ranch', tier: 'Volume', status: 'open', cityKey: 'fort-collins', holdReason: '' },
    'knock_reps/rep.one': { repKey: 'rep.one', username: 'Rep.One', displayName: 'Rep One', role: 'knocker', status: 'active', permitListed: true, premiumCleared: false, leadKey: '' },
    'knock_assignments/rep.one__english-ranch__all': { repKey: 'rep.one', neighborhoodId: 'english-ranch', street: '', active: true },
    'knock_houses/h-2900-blue-leaf-dr': { neighborhoodId: 'english-ranch', street: 'BLUE LEAF DR', number: '2900', unit: '', lat: 40.55, lng: -105.03, updatedAt: '2026-10-01T00:00:00.000Z' },
    'knock_houses/h-2902-blue-leaf-dr': { neighborhoodId: 'english-ranch', street: 'BLUE LEAF DR', number: '2902', unit: '', lat: 40.55, lng: -105.03, updatedAt: '2026-10-01T00:00:00.000Z' },
    ...extra,
  };
}

// Firestore requests made through the global fetch (the Hub roster's employee accounts) go to the fake; every other
// request is recorded and refused: HighLevel, Stripe, anything.
function recordNetwork(t, world) {
  const calls = [], original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === 'firestore.googleapis.com') return world.fake.fetcher({}, url.href, init);
    calls.push(url.href);
    throw new Error('Network refused in tests');
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

// The flags that would queue HighLevel tags and crew notices are ON, to prove this path writes neither.
async function setup(t, { extra = {} } = {}) {
  const env = knockEnv({ EGC_GHL_TAG_OUTBOX: 'true', EGC_CREW_NOTIFICATIONS_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_syntheticKnockKey', HIGHLEVEL_API_KEY: 'ghl-synthetic-key', HIGHLEVEL_LOCATION_ID: 'location-1' });
  const world = knockWorld(seed(extra));
  const network = recordNetwork(t, world);
  const hubStorage = e => dispatchStorage(e, world.fake.fetcher);
  const now = () => new Date(NOW);
  const sync = knockSyncHandlers({ storage: world.storage, now });
  const admin = knockAdminHandlers({ storage: world.storage, hubStorage, now });
  const cookies = { rep: await cookieFor(env, 'Rep.One'), zac: await cookieFor(env, 'ZacB') };
  const send = events => call(sync.post, post('/api/knock-sync', { events }, cookies.rep), env);
  const act = (body, cookie = cookies.zac) => call(admin.post, post('/api/knock-admin', body, cookie), env);
  const sales = () => call(admin.get, get('/api/knock-admin?view=sales', cookies.zac), env);
  const docs = prefix => [...world.fake.documents.keys()].filter(path => path.startsWith(`${prefix}/`)).map(path => ({ id: path.slice(prefix.length + 1), ...world.fake.get(path) }));
  return { env, world, network, send, act, sales, docs, hub: hubStorage(env) };
}

async function sell(send, { house = 'h-2900-blue-leaf-dr', customer = { name: 'Pat Synthetic', phone: '(970) 555-0100', email: 'Pat@Example.com' } } = {}) {
  const shiftId = uuid(), knockId = uuid(), saleId = uuid();
  const result = await send([
    { id: uuid(), type: 'shift.start', shiftId, cityKey: 'fort-collins', at: iso(NOW - 30 * MIN) },
    { id: knockId, type: 'knock', shiftId, houseId: house, outcome: 'sold', quotedAmount: 1600, carOutside: true, at: iso(NOW - 5 * MIN) },
    { id: saleId, type: 'sale', knockId, houseId: house, at: iso(NOW - 4 * MIN), ticket: 1600, package: 'The Works', customer, checklist: CHECKLIST, jobDate: '2026-10-10', jobStartTime: '08:30', textConsent: true },
  ]);
  assert.deepEqual(result.body.results.map(r => r.status), ['applied', 'applied', 'applied'], JSON.stringify(result.body));
  return saleId;
}

const create = (act, saleId, cookie) => act({ action: 'sale.handoff', saleId, kind: 'job', op: 'create' }, cookie);
const operational = docs => docs('jobs').filter(row => !row.recordType && row.type === 'job');

test('Create Hub job: one new customer and one unscheduled To schedule job with the sale facts, Notify customer off, nothing sent', async t => {
  const { world, network, send, act, docs, hub } = await setup(t);
  const saleId = await sell(send);
  const result = await create(act, saleId);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const jobs = operational(docs), customers = docs('customers');
  assert.equal(jobs.length, 1, 'exactly one Hub job');
  assert.equal(customers.length, 1, 'exactly one Hub customer');
  const [job] = jobs, [customer] = customers;

  // The customer, from the sale's details, matched like every Hub customer (normalized phone and email).
  assert.deepEqual([customer.name, customer.phone, customer.email, customer.address], ['Pat Synthetic', '+19705550100', 'pat@example.com', '2900 Blue Leaf Dr, Fort Collins, CO']);
  assert.equal(customer.source, 'manager_intake');

  // The job: unscheduled, waiting in To schedule for a manager, with the sale's facts.
  assert.equal(job.id, result.body.hubJob.id);
  assert.equal(result.body.hubJob.created, true);
  assert.deepEqual([job.type, job.customerId, job.status, job.pipelineStatus, job.date, job.time, job.assignedCrew.length], ['job', customer.id, 'unscheduled', 'unscheduled', '', '', 0]);
  assert.deepEqual([job.needsDispatchReview, job.dispatchReviewReason, job.leadSource, queueSource(job)], [true, 'sold_schedule_later', 'door_to_door', 'door_to_door']);
  assert.deepEqual([job.notify, job.customerAutomationEnabled, job.syncStatus, job.highlevelContactId, job.highlevelAppointmentId ?? ''], [false, false, 'not_needed', '', '']);
  assert.deepEqual([job.serviceType, job.address, job.preferredDate, job.preferredTime, job.total, job.priceQuoted, job.deposit.amount], ['The Works', '2900 Blue Leaf Dr, Fort Collins, CO', '2026-10-10', '08:30', 1600, 1600, 320]);
  assert.deepEqual([job.knockSale.saleId, job.knockSale.repName, job.knockSale.cancelDeadlineDate, job.knockSale.requestedJobDate, job.knockSale.depositAmount, job.knockSale.depositStatus], [saleId, 'Rep One', '2026-10-09', '2026-10-10', 320, 'pending']);
  assert.match(job.opsNotes, new RegExp(`^Door-to-door sale by Rep One on 2026-10-06; right-to-cancel deadline 2026-10-09 \\(midnight\\); knock sale ${saleId}\\.`));
  assert.match(job.opsNotes, /Requested job date 2026-10-10 at 08:30/);
  assert.match(job.opsNotes, /The Works, quoted \$1,600\. 20% deposit \$320: not collected/);
  assert.match(job.operationalScope.text, /^The Works, sold door to door\. The customer asked for 2026-10-10\./);
  assert.doesNotMatch(job.opsNotes + job.operationalScope.text, /555|example\.com/i, 'the notes name no phone or email');
  assert.doesNotMatch(job.operationalScope.text, /\$\d/, 'the crew-visible scope carries no amount');

  // The sale records the hand-off.
  const sale = world.fake.get(`knock_sales/${saleId}`);
  assert.deepEqual(sale.handoff.job, { mode: 'hub', status: 'created', ref: job.id, customerId: customer.id, at: iso(NOW), by: 'ZacB' });
  assert.deepEqual(result.body.sale.handoff.job, sale.handoff.job);
  assert.equal(world.fake.get(`knock_receipts/job_${saleId}`).outcome, 'created');

  // Nothing reached HighLevel, Stripe or any other host; no HighLevel tag, crew notice or funnel booking was queued.
  assert.deepEqual(network, []);
  assert.deepEqual([hub.ghlTagOutbox, hub.crewNotificationsEnabled], [true, true], 'the outbox flags are on in this test');
  for (const collection of ['ghlTagOutbox', 'crewNotifications', 'funnelEvents', 'message_sends']) assert.deepEqual(docs(collection), [], collection);
  assert.equal(job.ghlTagEntry, undefined);

  // Dispatch shows it in To schedule as a door-to-door sale.
  const board = await dispatchOverview(hub, { user: 'zacb', role: 'owner', businessAccess: true }, { startDate: '2026-10-06', endDate: '2026-10-13', includeUnscheduled: 'true' }, new Date(NOW), { readiness: true });
  const row = board.jobs.find(item => item.id === job.id);
  assert.deepEqual([row.queue.source, row.queue.sinceKind, row.needsDispatchReview, row.notify], ['door_to_door', 'created', true, false]);
  assert.equal(row.moneyReady.depositRequiredCents, 32000, 'the 20% deposit, not the Hub default');
});

test('an existing Hub customer is matched by phone and never duplicated', async t => {
  const { send, act, docs } = await setup(t, { extra: { 'customers/c-existing': { id: 'c-existing', name: 'Pat S.', phone: '970.555.0100', email: '', address: '2900 Blue Leaf Drive' } } });
  const saleId = await sell(send);
  const result = await create(act, saleId);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(docs('customers').map(row => row.id), ['c-existing']);
  assert.equal(operational(docs)[0].customerId, 'c-existing');
  assert.equal(result.body.sale.handoff.job.customerId, 'c-existing');
});

test('a customer the Hub cannot match safely is refused for review and nothing is created', async t => {
  const { send, act, docs, world } = await setup(t, { extra: {
    'customers/c-a': { id: 'c-a', name: 'Pat A', phone: '9705550100', email: '' },
    'customers/c-b': { id: 'c-b', name: 'Pat B', phone: '', email: 'pat@example.com' },
  } });
  const saleId = await sell(send);
  const result = await create(act, saleId);
  assert.deepEqual([result.status, result.body.code], [409, 'knock_hub_customer_review']);
  assert.equal(operational(docs).length, 0);
  assert.equal(world.fake.get(`knock_sales/${saleId}`).handoff.job.status, 'pending');
  assert.equal(world.fake.get(`knock_receipts/job_${saleId}`).outcome, 'failed', 'the claim is freed for the manual fallback or a retry');
  assert.equal((await act({ action: 'sale.handoff', saleId, kind: 'job', op: 'mark', ref: 'dispatch_hand_made' })).body.sale.handoff.job.ref, 'dispatch_hand_made', 'the manual fallback still works');
});

test('a second Create returns the same job and creates nothing', async t => {
  const { send, act, docs } = await setup(t);
  const saleId = await sell(send);
  const first = await create(act, saleId);
  const before = [...docs('jobs'), ...docs('customers'), ...docs('projects')].length;
  const again = await create(act, saleId);
  assert.equal(again.status, 200);
  assert.deepEqual([again.body.hubJob.id, again.body.hubJob.created], [first.body.hubJob.id, false]);
  assert.equal([...docs('jobs'), ...docs('customers'), ...docs('projects')].length, before);
  assert.equal(operational(docs).length, 1);
});

test('a double tap (two concurrent requests) creates one job', async t => {
  const { send, act, docs, world } = await setup(t);
  const saleId = await sell(send);
  const results = await Promise.all([create(act, saleId), create(act, saleId), create(act, saleId)]);
  assert.equal(operational(docs).length, 1, JSON.stringify(results.map(r => r.body.code || r.body.hubJob)));
  assert.equal(docs('customers').length, 1);
  const ok = results.filter(r => r.status === 200), busy = results.filter(r => r.status !== 200);
  assert.ok(ok.length >= 1);
  for (const r of busy) assert.equal(r.body.code, 'knock_job_in_progress');
  assert.equal(new Set(ok.map(r => r.body.hubJob.id)).size, 1);
  assert.equal(world.fake.get(`knock_sales/${saleId}`).handoff.job.ref, ok[0].body.hubJob.id);
  // After the race settles, another tap is the plain idempotent answer.
  assert.equal((await create(act, saleId)).body.hubJob.id, ok[0].body.hubJob.id);
});

test('a lost Hub save is found again by the fixed request ids, never created twice', async t => {
  const { send, act, docs, world } = await setup(t);
  const saleId = await sell(send);
  // The Hub job commit lands but its response is lost (dispatch recovers it from its receipt), then recording it on
  // the sale fails too: the first tap reports an error although the Hub job exists.
  const fetcher = world.fake.fetcher;
  let dropped = 0;
  world.fake.fetcher = async (env, url, options = {}) => {
    const response = await fetcher(env, url, options);
    const body = options.body ? JSON.parse(options.body) : null;
    if (!dropped && String(url).endsWith(':commit') && body?.writes?.some(w => /\/documents\/jobs\/dispatch_/.test(w.update?.name || ''))) { dropped += 1; throw new Error('connection reset'); }
    if (String(url).endsWith(':commit') && body?.writes?.some(w => /knock_sales\//.test(w.update?.name || '')) && dropped === 1) { dropped += 1; throw new Error('connection reset'); }
    return response;
  };
  const first = await create(act, saleId);
  assert.deepEqual([first.status, first.body.code, dropped], [503, 'knock_storage_unavailable', 2], JSON.stringify(first.body));
  assert.equal(operational(docs).length, 1, 'the Hub job was saved');
  world.fake.fetcher = fetcher;
  const retry = await create(act, saleId);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(operational(docs).length, 1, 'the retry found the saved job');
  assert.equal(retry.body.hubJob.id, operational(docs)[0].id);
  assert.equal(world.fake.get(`knock_sales/${saleId}`).handoff.job.ref, retry.body.hubJob.id);
});

test('a cancelled sale and a non-admin are refused, and a manual job is not replaced', async t => {
  const { env, send, act, docs, network } = await setup(t);
  const cancelled = await sell(send);
  await act({ action: 'sale.status', saleId: cancelled, status: 'cancelled' });
  assert.deepEqual([(await create(act, cancelled)).status, (await create(act, cancelled)).body.code], [409, 'knock_sale_cancelled']);

  const other = await sell(send, { house: 'h-2902-blue-leaf-dr', customer: { name: 'Sam Synthetic', phone: '(970) 555-0101', email: 'sam@example.com' } });
  const rep = await create(act, other, await cookieFor(env, 'Rep.One'));
  assert.deepEqual([rep.status, rep.body.code], [403, 'knock_admin_required']);
  await act({ action: 'sale.handoff', saleId: other, kind: 'job', op: 'mark', ref: 'HUB-123' });
  assert.equal((await create(act, other)).body.code, 'knock_job_already_recorded');
  assert.equal(operational(docs).length, 0);
  assert.deepEqual(network, []);
});

test('a Hub job keeps its reference: the manual mark cannot overwrite it', async t => {
  const { send, act } = await setup(t);
  const saleId = await sell(send);
  const made = await create(act, saleId);
  const mark = await act({ action: 'sale.handoff', saleId, kind: 'job', op: 'mark', ref: 'something-else' });
  assert.deepEqual([mark.status, mark.body.code], [409, 'knock_job_hub_created']);
  assert.match(mark.body.error, new RegExp(made.body.hubJob.id));
});

test('cancelling a sale with a Hub job warns that the job is still open and never cancels it', async t => {
  const { send, act, sales, world } = await setup(t);
  const saleId = await sell(send);
  const { body } = await create(act, saleId);
  const jobId = body.hubJob.id;
  const cancelled = await act({ action: 'sale.status', saleId, status: 'cancelled' });
  assert.equal(cancelled.status, 200);
  assert.deepEqual(cancelled.body.warnings, [{ code: 'knock_hub_job_open', jobId, message: openHubJobMessage(jobId) }]);
  assert.equal(openHubJobMessage(jobId), `Hub job ${jobId} still open — cancel it in Dispatch`);
  assert.equal(world.fake.get(`jobs/${jobId}`).status, 'unscheduled', 'the Hub job is untouched');
  let view = (await sales()).body.sales.find(sale => sale.id === saleId);
  assert.deepEqual(view.hubJobWarning, { code: 'knock_hub_job_open', jobId, message: openHubJobMessage(jobId) });
  // Once Dispatch cancels the job, the warning goes away.
  const { revision, ...stored } = world.fake.get(`jobs/${jobId}`);
  world.fake.put(`jobs/${jobId}`, { ...stored, status: 'cancelled', pipelineStatus: 'cancelled' });
  view = (await sales()).body.sales.find(sale => sale.id === saleId);
  assert.equal('hubJobWarning' in view, false);
  // A sale with a manual job or none never warns.
  assert.equal((await sales()).body.sales.filter(sale => sale.hubJobWarning).length, 0);
});

test('the request ids are fixed per sale and the note is built from the sale', async () => {
  assert.equal(await saleRequestId('job', 'sale-1'), await saleRequestId('job', 'sale-1'));
  assert.notEqual(await saleRequestId('job', 'sale-1'), await saleRequestId('customer', 'sale-1'));
  assert.match(await saleRequestId('job', 'sale-1'), /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const note = internalNote({ id: 's1', saleDate: '2026-10-06', cancelDeadlineDate: '2026-10-09', jobDate: '2026-10-12', jobStartTime: '', package: 'Quick Clear', ticket: 1234.5, depositRate: 0.2, depositAmount: 246.9, handoff: { deposit: { status: 'collected' } } }, 'Rep One');
  assert.match(note, /^Door-to-door sale by Rep One on 2026-10-06; right-to-cancel deadline 2026-10-09 \(midnight\); knock sale s1\./);
  assert.match(note, /Requested job date 2026-10-12\. Needs a time/);
  assert.match(note, /Quick Clear, quoted \$1,234\.50\. 20% deposit \$246\.90: collected \(recorded in Knock/);
});
