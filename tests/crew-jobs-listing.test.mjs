import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { dispatchStorage } from '../functions/_lib/dispatch-storage.js';
import { crewJobProjection, CREW_PROJECTION_FIELDS } from '../functions/_lib/crew-job-projection.js';
import { crewJobsHandlers, CREW_LISTING_FIELDS } from '../functions/api/crew-jobs.js';

const NOW = new Date('2026-09-22T12:00:00.000Z');
const env = { FIREBASE_API_KEY: 'firebase-test-crew-listing' };
const crew = { user: 'crew.one', displayName: 'Crew One', role: 'crew' };
const manager = { user: 'zacb', displayName: 'Owner', role: 'owner', businessAccess: true };
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents';
const updateTime = index => `2026-09-2${index % 2}T00:00:00.${String(index).padStart(6, '0')}Z`;

// Firestore read-mask semantics: only the named (possibly nested) fields come
// back, and a document holding none of them is returned without `fields`.
function masked(data, paths) {
  if (!paths.length) return data;
  const out = {};
  for (const path of paths) {
    const keys = path.split('.');
    let value = data;
    for (const key of keys) value = value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key) ? value[key] : undefined;
    if (value === undefined) continue;
    let target = out;
    for (const key of keys.slice(0, -1)) target = target[key] ||= {};
    target[keys.at(-1)] = structuredClone(value);
  }
  return out;
}

// Fake Firestore REST list endpoint: pages of 500 with opaque page tokens.
// ignoreMask models an unmasked read so tests can compare the two outputs.
function firestore(rows, options = {}) {
  const calls = [];
  const fetcher = async (_env, input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, method: init.method || 'GET', mask: url.searchParams.getAll('mask.fieldPaths') });
    if (options.fail) return Response.json({}, { status: 500 });
    assert.equal(url.pathname, `/v1/${ROOT}/jobs`);
    const paths = options.ignoreMask ? [] : url.searchParams.getAll('mask.fieldPaths');
    const documents = rows.map(([id, data], index) => {
      const fields = masked(data, paths);
      return { name: `${ROOT}/jobs/${id}`, ...(Object.keys(fields).length ? { fields: encodeFirestoreFields(fields) } : {}), updateTime: updateTime(index) };
    });
    const size = Number(url.searchParams.get('pageSize')), offset = Number(url.searchParams.get('pageToken') || 0);
    const next = offset + size < documents.length ? String(offset + size) : '';
    return Response.json({ documents: documents.slice(offset, offset + size), ...(next ? { nextPageToken: options.loopToken ? '0' : next } : {}) });
  };
  return { calls, storage: () => dispatchStorage(env, fetcher) };
}
const listing = (actor, fake) => crewJobsHandlers({ session: async () => actor, storage: fake.storage, now: () => NOW });
const get = handler => handler.get({ request: new Request('https://easygaragecleaning.com/api/crew-jobs'), env });

const filler = count => Array.from({ length: count }, (_, index) => [`history-${String(index).padStart(4, '0')}`, { type: 'job', status: 'completed', date: '2025-01-01', assignedCrew: ['someone.else'], customer: 'Old customer' }]);

test('crew schedule reads every page of the jobs collection instead of the first 500 rows', async () => {
  const fake = firestore([...filler(1203), ['zz-late-assignment', { type: 'job', status: 'scheduled', date: '2026-09-23', time: '09:00', endTime: '11:00', assignedCrew: ['crew.one'], customer: 'Late page customer', estimate: { total: 900 } }]]);
  const response = await get(listing(crew, fake));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(body.jobs.map(job => job.id), ['zz-late-assignment']);
  assert.equal(body.jobs[0].customer, 'Late page customer');
  assert.equal(body.jobs[0].estimate, undefined, 'crew receive the projection, never the raw record');
  assert.ok(body.jobs[0].expectedRevision, 'the projection now carries the verifiable Firestore revision');
  assert.deepEqual(body.coverage, { complete: true, asOf: NOW.toISOString() });
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(fake.calls.map(call => call.url.searchParams.get('pageToken')), [null, '500', '1000']);
  assert.ok(fake.calls.every(call => call.method === 'GET' && call.mask.join() === CREW_LISTING_FIELDS.join()), 'every page is read through the listing mask');
});

test('private locks, receipts and encrypted records are never listed, even for managers', async () => {
  const rows = [
    ['_egc_schedule_lock_2026-09-23', { recordType: 'schedule_lock', date: '2026-09-23', entries: [], assignedCrew: ['crew.one'] }],
    ['_egc_schedule_op_1234', { recordType: 'schedule_operation', fingerprint: 'secret', assignedCrew: ['crew.one'] }],
    ['secure_profile_1', { recordType: 'employee_hub_v2', ciphertext: 'sealed', employee: 'crew.one', type: 'availability' }],
    ['secure_legacy', { type: 'job', assignedCrew: ['crew.one'], customer: 'Encrypted legacy row' }],
    ['receipt-without-prefix', { recordType: 'schedule_provider_receipt', type: 'job', assignedCrew: ['crew.one'] }],
    ['assigned', { type: 'job', status: 'scheduled', date: '2026-09-23', time: '09:00', endTime: '10:00', assignedCrew: ['crew.one'], customer: 'Assigned', opsNotes: 'Private manager note' }],
    ['own-time-off', { type: 'availability', recordType: 'crew_availability', employee: 'crew.one', date: '2026-09-24', allDay: true, status: 'active', reason: 'Appointment' }],
    ['other-time-off', { type: 'availability', recordType: 'crew_availability', employee: 'crew.two', date: '2026-09-24', allDay: true, status: 'active', reason: 'Private reason' }],
  ];
  const crewBody = await (await get(listing(crew, firestore(rows)))).json();
  assert.deepEqual(crewBody.jobs.map(job => job.id).sort(), ['assigned', 'own-time-off']);
  assert.equal(crewBody.jobs.find(job => job.id === 'assigned').opsNotes, undefined);
  assert.equal(crewBody.jobs.find(job => job.id === 'own-time-off').reason, 'Appointment');

  const managerBody = await (await get(listing(manager, firestore(rows)))).json();
  assert.deepEqual(managerBody.jobs.map(job => job.id).sort(), ['assigned', 'other-time-off', 'own-time-off']);
  const managed = managerBody.jobs.find(job => job.id === 'assigned');
  assert.equal(managed.customer, 'Assigned', 'managers keep the fields their schedule views read');
  assert.equal(managed.opsNotes, undefined, 'fields no listing consumer reads are no longer loaded');
});

test('open shifts stay redacted for other crew members and unrelated work stays hidden', async () => {
  const rows = [
    ['open', { type: 'job', status: 'scheduled', openShift: true, shiftPickupEnabled: true, customer: 'Private Customer', address: '3 Private Way', phone: '9705550100', date: '2026-09-23', time: '09:00', endTime: '11:00', assignedCrew: ['crew.two'], crewNeeded: 2 }],
    ['closed-pickup', { type: 'job', status: 'scheduled', openShift: false, shiftPickupEnabled: true, customer: 'Full shift', assignedCrew: ['crew.two'] }],
    ['walkthrough-open', { type: 'walkthrough', openShift: true, shiftPickupEnabled: true, customer: 'Not a shift' }],
  ];
  const body = await (await get(listing(crew, firestore(rows)))).json();
  assert.deepEqual(body.jobs.map(job => job.id), ['open']);
  assert.deepEqual(body.jobs[0], { id: 'open', type: 'job', status: 'scheduled', pipelineStatus: 'scheduled', date: '2026-09-23', time: '09:00', endTime: '11:00', serviceType: 'Garage service', customer: 'Open shift', address: '', assignedTo: '', assignedCrew: [], assignedCount: 1, crewNeeded: 2, openShift: true, shiftPickupEnabled: true });
});

test('unavailable or incomplete storage is an error, never an empty schedule', async () => {
  const failed = await get(listing(crew, firestore(filler(3), { fail: true })));
  assert.equal(failed.status, 503);
  const failure = await failed.json();
  assert.equal(failure.ok, false); assert.equal(failure.code, 'dispatch_storage_unavailable'); assert.equal(failure.jobs, undefined);

  const looping = await get(listing(crew, firestore(filler(1001), { loopToken: true })));
  assert.equal(looping.status, 503);
  assert.equal((await looping.json()).code, 'dispatch_storage_incomplete');

  const thrown = await get(crewJobsHandlers({ session: async () => crew, storage: () => ({ jobRecords: async () => { throw new TypeError('socket detail'); } }), now: () => NOW }));
  assert.equal(thrown.status, 503);
  assert.deepEqual(await thrown.json(), { ok: false, code: 'schedule_storage_unavailable', error: 'Schedule storage is unavailable' });
});

test('the listing still requires a signed session and configured secure storage before reading', async () => {
  let reads = 0;
  const storage = () => ({ jobRecords: async () => { reads++; return []; } });
  const anonymous = await crewJobsHandlers({ session: async () => null, storage, now: () => NOW }).get({ request: new Request('https://easygaragecleaning.com/api/crew-jobs'), env });
  assert.equal(anonymous.status, 401);
  const unconfigured = await crewJobsHandlers({ session: async () => crew, storage, now: () => NOW }).get({ request: new Request('https://easygaragecleaning.com/api/crew-jobs'), env: {} });
  assert.equal(unconfigured.status, 503);
  assert.equal(reads, 0);
});

// A representative in-progress job carrying every field the projections read,
// plus the large and private fields no listing reader needs.
const SIGNATURE = `data:image/png;base64,${'iVBORw0KGgo'.repeat(20000)}`;
const PHOTO_ID = '0b6c6f1e-8d2a-4c1b-9e3f-2a7d5c4b1a00';
const representative = {
  type: 'job', status: 'in_progress', pipelineStatus: 'in_progress', date: '2026-09-23', time: '09:00', endDate: '2026-09-23', endTime: '12:00',
  startAt: '2026-09-23T15:00:00.000Z', endAt: '2026-09-23T18:00:00.000Z', timeZone: 'America/Denver', arrivalWindow: '9:00-9:30',
  customer: 'Synthetic Customer', customerName: 'Synthetic Customer', phone: '970-555-0101', address: '1 Synthetic Way', serviceType: 'Garage cleanout', title: 'Synthetic cleanout',
  assignedCrew: ['crew.one', 'crew.two'], assignedTo: 'crew.one, crew.two', crewLead: 'crew.one', crewId: 'crew-a', crewName: 'Crew A', vehicleId: 'truck-1', vehicleName: 'Truck 1',
  crewNeeded: 2, crewSize: 2, requiredCrewSize: 2, durationMin: 180, estimatedDurationMin: 170, shiftPickupEnabled: true, openShift: false,
  shiftClaims: [{ employee: 'crew.two', claimedAt: '2026-09-20T10:00:00.000Z' }], lastShiftClaim: { employee: 'crew.two', claimedAt: '2026-09-20T10:00:00.000Z' },
  jobInstructions: { arrivalWindow: '9-10', customerGoal: 'Park two cars', keepItems: ['Bikes'], removeItems: ['Old paint'], exclusions: 'Attic', hazards: ['Glass'], accessNotes: 'Code on file', access: ['Side door'], truckPlacement: 'Driveway', customerNotes: 'Dog in yard' },
  operationalScope: { text: 'Full garage cleanout', internalCost: 1234 }, scope: { keep_items: 'Bikes', hazards: ['Glass'] }, scopeOfWork: 'Legacy scope',
  logistics: { notes: 'Gate code on file', access: ['Side door'], truck_placement: 'Street', requiredEquipment: ['Dolly'], internalRoute: 'Private route' },
  discovery: { success: 'Two cars parked', budget: 5000 }, accessInstructions: 'Use side door', customerInstructions: 'Call on arrival', customerNotesSummary: 'Dog in yard',
  requiredEquipment: ['Dolly', 'Tarps'], materials: [{ id: 'bags', name: 'Contractor bags', quantity: 20 }],
  clientChecklists: { preJob: [{ id: 'notes', label: 'Review notes' }], postJob: ['Sweep floor'], internal: [{ label: 'Private checklist' }] },
  fieldExecution: {
    activity: 'in_progress', activityReason: '', checklistTemplate: [{ id: 'custom-1', stage: 'work', label: 'Custom task' }],
    checks: { 'custom-1': { completed: true, at: '2026-09-23T16:00:00.000Z', actorName: 'Crew One' } }, materialStates: { bags: { state: 'loaded', at: '2026-09-23T15:10:00.000Z', actorId: 'crew.one' } },
    photos: [{ id: PHOTO_ID, category: 'before', verified: true, fileId: 'drive-file-1', caption: 'Before', createdAt: '2026-09-23T15:05:00.000Z', actorName: 'Crew One', bytes: 1000 }],
    attention: { requestId: 'issue-1', at: '2026-09-23T15:30:00.000Z', actorName: 'Crew One', visibility: 'crew', reason: 'Broken shelf', status: 'open' },
    completion: { completedAt: '2026-09-23T17:00:00.000Z', actorName: 'Crew One', notes: 'Earlier completion notes', hasIssues: false, issueNotes: '' },
    jobTime: { version: 1, trackingStartedAt: '2026-09-22T11:00:00.000Z', totalsMs: { work: 0, paused: 0, waiting: 0, delayed: 0, travel: 600000, arrival: 0 }, current: { kind: 'work', startedAt: '2026-09-22T11:10:00.000Z' } },
    privateAudit: 'Private field audit',
  },
  fieldCompletionSync: { status: 'pending', message: 'Awaiting CRM', attemptedAt: '2026-09-23T17:01:00.000Z', body: 'Private CRM body', providerContactId: 'ghl-private' },
  startedAt: '2026-09-23T15:10:00.000Z',
  customerConversation: [{ id: 'm1', requestId: 'r1', direction: 'to_customer', authorRole: 'crew', authorName: 'Crew One', body: 'On our way', createdAt: '2026-09-23T14:50:00.000Z', delivery: { channel: 'sms', status: 'sent', attemptedAt: '2026-09-23T14:50:01.000Z', providerMessageId: 'ghl-message-private' } }],
  customerConversationUpdatedAt: '2026-09-23T14:50:01.000Z',
  quoteAmount: 1250, total: 1250, cubicYards: 8, notes: 'Bring extra bins', customerAddress: '1 Synthetic Way', customerPhone: '970-555-0101',
  acceptance: { signature: SIGNATURE, acceptedBy: 'Synthetic Customer', method: 'in_person_signature' },
  estimate: { total: 1250, lineItems: [{ name: 'Cleanout', amount: 1250 }] }, deposit: { paidAmount: 250, reference: 'pi_synthetic_private' },
  payments: [{ amount: 250, receiptUrl: 'https://pay.stripe.com/receipts/synthetic-private' }], internalNotes: 'Private internal note', opsNotes: 'Private ops note',
};
const PRIVATE_ROOTS = ['acceptance', 'estimate', 'deposit', 'payments', 'internalNotes', 'opsNotes', 'highlevelContactId'];
const rows = [
  ['representative', representative],
  // Older shape: string instructions and the fallback maps the projection reads.
  ['legacy-shape', { type: 'job', status: 'scheduled', date: '2026-09-24', time: '10:00', endTime: '12:00', assignedTo: 'crew.one + Crew Two', customer: 'Synthetic Legacy',
    jobInstructions: 'Legacy instruction text', instructions: { arrivalWindow: '10-11', exclusions: 'Loft stairs' }, discovery: { success: 'Clear the floor', budget: 900 },
    scope: { keep_items: 'Tools', remove_items: 'Boxes', exclusions: 'Loft', hazards: ['Nails'], access: ['Front'] },
    logistics: { truck_placement: 'Alley', access: ['Alley gate'], requiredEquipment: ['Hand truck'], notes: 'Alley notes', internalRoute: 'Private' },
    requiredMaterials: ['Tarps'], crewSize: 3, customerNotesSummary: 'Summary note', fieldCompletionSync: { status: 'synced', syncedAt: '2026-09-21T10:00:00.000Z', body: 'Private CRM body' },
    completedAt: '2026-09-21T09:00:00.000Z', cancelledAt: '2026-09-21T09:30:00.000Z', acceptance: { signature: SIGNATURE } }],
  ['own-time-off', { type: 'availability', recordType: 'crew_availability', employee: 'crew.one', date: '2026-09-24', endDate: '2026-09-25', allDay: true, status: 'active', reason: 'Appointment', signature: SIGNATURE }],
  ['open-elsewhere', { ...representative, assignedCrew: ['crew.two'], assignedTo: 'crew.two', openShift: true, crewNeeded: 3 }],
];

test('the listing mask excludes signatures and private fields and never overlaps', async () => {
  const received = [];
  const response = await get(crewJobsHandlers({ session: async () => crew, storage: () => ({ jobRecords: async fields => { received.push(fields); return []; } }), now: () => NOW }));
  assert.equal(response.status, 200);
  assert.deepEqual(received, [CREW_LISTING_FIELDS], 'the store receives the listing mask');
  const mask = received[0];
  assert.equal(new Set(mask).size, mask.length);
  for (const path of mask) assert.ok(!mask.some(other => other !== path && other.startsWith(path + '.')), `${path} overlaps a narrower path`);
  for (const root of PRIVATE_ROOTS) assert.ok(!mask.some(path => path === root || path.startsWith(root + '.')), `${root} must not be requested`);
  assert.ok(!mask.some(path => /signature/i.test(path)));
  for (const field of CREW_PROJECTION_FIELDS) assert.ok(mask.includes(field), `projection input ${field} is requested`);
  for (const field of ['type', 'recordType', 'status', 'date', 'endDate']) assert.ok(mask.includes(field), `filter input ${field} is requested`);
  await assert.rejects(dispatchStorage(env, async () => assert.fail('an unmasked scan must not be sent')).jobRecords(), error => error.code === 'dispatch_storage_mask_required');
});

test('masked reads return the same crew projections and manager view fields as a full read', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const read = async (actor, options) => {
    const fake = firestore(rows, options), response = await get(listing(actor, fake)), text = await response.text();
    assert.equal(response.status, 200);
    return { text, body: JSON.parse(text), calls: fake.calls };
  };
  const maskedCrew = await read(crew, {}), fullCrew = await read(crew, { ignoreMask: true });
  assert.deepEqual(maskedCrew.body, fullCrew.body, 'crew projections and open shifts are unchanged by the mask');
  assert.deepEqual(maskedCrew.body.jobs.map(job => job.id), ['representative', 'legacy-shape', 'own-time-off', 'open-elsewhere']);
  const source = { ...decodeFirestoreFields(encodeFirestoreFields(representative)), id: 'representative', revision: updateTime(0) };
  assert.deepEqual(maskedCrew.body.jobs[0], JSON.parse(JSON.stringify(crewJobProjection(source))));
  assert.equal(maskedCrew.body.jobs[0].photos.length, 1); assert.equal(maskedCrew.body.jobs[0].checklist.find(item => item.id === 'custom-1').completed, true);
  assert.equal(maskedCrew.body.jobs[0].jobTime.runningKind, 'work'); assert.equal(maskedCrew.body.jobs[0].customerConversation[0].body, 'On our way');
  const legacy = maskedCrew.body.jobs[1];
  assert.deepEqual([legacy.customerGoal, legacy.keepItems, legacy.accessInstructions, legacy.truckPlacement, legacy.scope], ['Clear the floor', 'Tools', 'Alley notes', 'Alley', 'Legacy instruction text']);
  assert.equal(maskedCrew.body.jobs[3].customer, 'Open shift');
  assert.ok(maskedCrew.calls.every(call => call.mask.length === CREW_LISTING_FIELDS.length));

  const maskedManager = await read(manager, {}), fullManager = await read(manager, { ignoreMask: true });
  assert.ok(!maskedManager.text.includes('data:image/png'), 'no signature image reaches the response');
  const managed = maskedManager.body.jobs.find(job => job.id === 'representative'), full = fullManager.body.jobs.find(job => job.id === 'representative');
  assert.equal(full.acceptance.signature, SIGNATURE, 'the unmasked baseline did carry the signature');
  for (const root of PRIVATE_ROOTS) assert.equal(managed[root], undefined, `${root} is not loaded`);
  // Fields read from manager rows by crew/index.html and copilot.html (strip and /api/copilot schedule).
  for (const field of ['id', 'type', 'recordType', 'date', 'time', 'endTime', 'status', 'pipelineStatus', 'assignedCrew', 'assignedTo', 'customer', 'address', 'serviceType',
    'customerName', 'name', 'timeWindow', 'scheduledTime', 'quoteAmount', 'total', 'priceQuoted', 'amount', 'cubicYards', 'customerAddress', 'customerPhone', 'phone', 'notes']) {
    assert.deepEqual(managed[field], full[field], `manager field ${field} is unchanged`);
  }
  assert.equal(managed.quoteAmount, 1250); assert.equal(managed.notes, 'Bring extra bins');
});

// In-memory dispatch store for the shift POST (dispatch-service fixture shape).
function shiftStore() {
  const rows = new Map([
    ['jobs/pickup', { id: 'pickup', type: 'job', status: 'scheduled', pipelineStatus: 'scheduled', date: '2026-09-23', time: '09:00', endTime: '11:00', shiftPickupEnabled: true, openShift: true, crewNeeded: 1, assignedCrew: [], customer: 'Synthetic Customer', address: '2 Synthetic Way', estimate: { total: 900 }, revision: 'r0' }],
    ['blocked_days/2026-09-23', { id: '2026-09-23', revision: 'legacy-r' }],
  ]);
  let revision = 0;
  const all = collection => [...rows.entries()].filter(([key]) => key.startsWith(collection + '/')).map(([, value]) => structuredClone(value));
  return {
    rows,
    jobs: async () => all('jobs'), resources: async () => all('dispatchResources'), customers: async () => [], roster: async () => [{ id: 'crew.one', name: 'Crew One', role: 'crew' }, { id: 'zacb', name: 'Owner', role: 'owner' }],
    read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null),
    legacyBlockMode: 'warn', legacyBlockedDays: async dates => dates.filter(date => rows.has(`blocked_days/${date}`)),
    commit: async writes => {
      for (const write of writes) { const old = rows.get(`${write.collection}/${write.id}`); if (write.revision ? old?.revision !== write.revision : Boolean(old)) throw Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 }); }
      for (const write of writes) rows.set(`${write.collection}/${write.id}`, { ...rows.get(`${write.collection}/${write.id}`), ...structuredClone(write.patch), id: write.id, revision: `r${++revision}` });
    },
  };
}

test('shift POST responses carry the self-assignment warnings and keep their shape', async t => {
  const store = shiftStore();
  // readJob performs the handler's existence check through Firestore REST.
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input), id = decodeURIComponent(url.pathname.split('/documents/jobs/')[1] || '');
    assert.equal(url.hostname, 'firestore.googleapis.com');
    const row = store.rows.get(`jobs/${id}`);
    return row ? Response.json({ name: `${ROOT}/jobs/${id}`, fields: encodeFirestoreFields(row), updateTime: row.revision }) : Response.json({}, { status: 404 });
  });
  const handlers = crewJobsHandlers({ session: async () => crew, storage: () => store, now: () => NOW });
  const post = body => handlers.post({ env, request: new Request('https://easygaragecleaning.com/api/crew-jobs', { method: 'POST', headers: { Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const claimBody = { action: 'claim', jobId: 'pickup', requestId: randomUUID() };
  const claimed = await post(claimBody);
  assert.equal(claimed.status, 200);
  const result = await claimed.json();
  assert.deepEqual(Object.keys(result).sort(), ['action', 'job', 'ok', 'replayed', 'warnings']);
  assert.equal(result.ok, true); assert.equal(result.action, 'claim'); assert.equal(result.replayed, false);
  assert.deepEqual(result.job.assignedCrew, ['crew.one']); assert.equal(result.job.estimate, undefined);
  assert.deepEqual(result.warnings.map(row => [row.code, row.jobId, row.date]), [['legacy_blocked_day', 'pickup', '2026-09-23']]);
  assert.equal(store.rows.get('jobs/pickup').updatedAt, NOW.toISOString(), 'the injected clock reaches the mutation');

  const replay = await (await post(claimBody)).json();
  assert.equal(replay.replayed, true); assert.deepEqual(replay.warnings, []);
  const released = await (await post({ action: 'release', jobId: 'pickup', requestId: randomUUID() })).json();
  assert.equal(released.ok, true); assert.deepEqual(released.warnings, []); assert.equal(released.job.customer, 'Open shift');
});
