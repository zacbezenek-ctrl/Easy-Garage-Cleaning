import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { FUNNEL_EVENTS_COLLECTION, FUNNEL_EVENT_INDEXES, funnelEventId, funnelEventWrite, resolveDeviceClock } from '../functions/_lib/funnel-events.js';
import { definitionsHash, funnelDefinitions } from '../functions/_lib/funnel-definitions.js';
import { funnelPeriod } from '../functions/_lib/funnel-calendar.js';

const NOW = '2026-09-22T12:00:00.000Z';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const owner = { id: 'zacb', kind: 'human', role: 'owner' };
const job = (id = 'job-1', extra = {}) => ({ id, type: 'job', customerId: 'customer-1', ...extra });
const scheduled = (extra = {}) => ({
  type: 'job.scheduled', idempotencyKey: { kind: 'requestId', value: extra.requestId || randomUUID() }, jobId: 'job-1', projectId: 'project_w1', customerId: 'customer-1',
  actor: owner, via: 'hub', source: { collection: 'dispatchOperations', id: 'receipt-1' }, data: { channel: 'hub_phone', visitPurpose: 'service' },
  eligibility: { hub: job() }, ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'requestId')),
});

// In-memory Firestore: create-only writes without a revision, compare-and-set with one,
// the whole commit or nothing, and a new revision per write.
function memoryStore(seed = {}) {
  const rows = new Map(Object.entries(seed).map(([key, value]) => [key, { ...structuredClone(value), revision: 'r0' }]));
  let n = 0; const commits = [];
  return {
    rows, commits, reads: 0,
    async read(collection, id) { this.reads += 1; const row = rows.get(`${collection}/${id}`); return row ? structuredClone({ ...row, id }) : null; },
    async commit(writes) {
      const keys = writes.map(write => `${write.collection}/${write.id}`);
      assert.equal(new Set(keys).size, keys.length, 'a commit never writes one document twice');
      for (const write of writes) {
        const current = rows.get(`${write.collection}/${write.id}`);
        if (write.revision ? current?.revision !== write.revision : current) throw Object.assign(new Error('conflict'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      for (const write of writes) rows.set(`${write.collection}/${write.id}`, { ...(write.revision ? rows.get(`${write.collection}/${write.id}`) : {}), ...structuredClone(write.patch), revision: `r${++n}` });
      commits.push(keys);
    },
  };
}

test('an event is one create-only write, stamped with provenance, definitions and Denver date', async () => {
  const requestId = randomUUID().toUpperCase();
  const write = await funnelEventWrite(null, NOW, scheduled({ requestId }));
  assert.equal(write.collection, FUNNEL_EVENTS_COLLECTION);
  assert.equal(write.revision, undefined, 'no revision: the commit creates it with exists:false');
  assert.match(write.id, /^fe_[0-9a-f]{40}$/);
  assert.equal(write.id, funnelEventId('job.scheduled', { field: 'jobId', value: 'job-1' }, `requestId:${requestId.toLowerCase()}`));
  assert.equal(write.data, write.patch);
  const doc = write.patch;
  assert.deepEqual({ ...doc, fingerprint: typeof doc.fingerprint }, {
    schemaVersion: 1, definitionsVersion: funnelDefinitions().definitionsVersion, definitionsHash: definitionsHash(),
    type: 'job.scheduled', group: 'visit', entityKey: 'jobId:job-1',
    occurredAt: NOW, clockSource: 'server', clockReasons: [], recordedAt: NOW, denverDate: '2026-09-22', deviceAt: null,
    projectId: 'project_w1', jobId: 'job-1', walkthroughId: null, customerId: 'customer-1', businessAccountId: null, inquiryId: null, membershipId: null, highlevelContactId: null, highlevelOpportunityId: null,
    actor: { id: 'zacb', kind: 'human', role: 'owner' }, via: 'hub', data: { channel: 'hub_phone', visitPurpose: 'service' },
    source: { collection: 'dispatchOperations', id: 'receipt-1' }, idempotencyKey: `requestId:${requestId.toLowerCase()}`, fingerprint: 'string',
    isTest: false, isInternal: false, internalReason: null, exclusion: null,
  });
  const late = await funnelEventWrite(null, '2026-09-23T05:30:00.000Z', scheduled());
  assert.equal(late.patch.denverDate, '2026-09-22', '11:30 pm Denver is still the 22nd');
});

test('the event lands in the same commit as its business change, and never twice', async () => {
  const store = memoryStore({ 'jobs/job-1': job() });
  const requestId = randomUUID();
  const current = await store.read('jobs', 'job-1');
  const event = await funnelEventWrite(store, NOW, scheduled({ requestId }));
  await store.commit([{ collection: 'jobs', id: 'job-1', revision: current.revision, patch: { date: '2026-09-30' } }, event]);
  assert.equal(store.rows.get(`funnelEvents/${event.id}`).type, 'job.scheduled');
  // Re-sending the prepared commit is refused as a whole: no second event, no second change.
  const again = (await store.read('jobs', 'job-1')).revision;
  await assert.rejects(store.commit([{ collection: 'jobs', id: 'job-1', revision: again, patch: { date: '2026-10-01' } }, event]), error => error.code === 'dispatch_revision_conflict');
  assert.equal(store.rows.get('jobs/job-1').date, '2026-09-30');
  // A stale business revision rejects the event with it.
  const other = await funnelEventWrite(store, NOW, scheduled());
  await assert.rejects(store.commit([{ collection: 'jobs', id: 'job-1', revision: current.revision, patch: { date: '2026-10-02' } }, other]));
  assert.equal(store.rows.has(`funnelEvents/${other.id}`), false);
});

test('a retry after a lost response resolves to the saved event; a different event under the same key is a conflict', async () => {
  const store = memoryStore({ 'jobs/job-1': job() });
  const requestId = randomUUID();
  const first = await funnelEventWrite(store, NOW, scheduled({ requestId }));
  await store.commit([first]);
  // Same logical event at a later server time (server-clock fields are not part of the fingerprint).
  assert.equal(await funnelEventWrite(store, () => new Date('2026-09-22T12:05:00.000Z'), scheduled({ requestId })), null);
  await assert.rejects(funnelEventWrite(store, NOW, scheduled({ requestId, data: { channel: 'portal', visitPurpose: 'service' } })), error => error.code === 'funnel_event_idempotency_conflict' && error.status === 409);
  // The same request may emit different event types; each has its own id.
  const assigned = await funnelEventWrite(store, NOW, { ...scheduled({ requestId }), type: 'job.assigned', data: {} });
  assert.notEqual(assigned.id, first.id);
  const failing = { read: async () => { throw Object.assign(new Error('down'), { code: 'dispatch_storage_unavailable', status: 503 }); } };
  await assert.rejects(funnelEventWrite(failing, NOW, scheduled()), error => error.code === 'dispatch_storage_unavailable', 'an unreadable ledger fails closed');
});

test('the server clock may be an ISO string, Date, epoch ms or function, and must be valid', async () => {
  const requestId = randomUUID();
  const ids = await Promise.all([NOW, new Date(NOW), Date.parse(NOW), () => NOW, () => new Date(NOW)].map(clock => funnelEventWrite(null, clock, scheduled({ requestId }))));
  assert.equal(new Set(ids.map(write => JSON.stringify(write.patch))).size, 1);
  for (const clock of [undefined, 'yesterday', () => { throw new Error('clock'); }, NaN, -1]) {
    await assert.rejects(funnelEventWrite(null, clock, scheduled()), error => error.code === 'funnel_event_invalid', String(clock));
  }
});

test('events are validated against the shared definitions before anything is saved', async () => {
  const rejects = async (event, pattern) => assert.rejects(funnelEventWrite(null, NOW, event), error => error.code === 'funnel_event_invalid' && pattern.test(error.message) && /Nothing was saved/.test(error.message), pattern.toString());
  await rejects({ ...scheduled(), type: 'job.teleported' }, /type is not defined/);
  await rejects({ ...scheduled(), jobId: undefined, eligibility: {} }, /needs one of jobId/);
  await rejects({ ...scheduled(), jobId: '_egc_schedule_op_1' }, /jobId is not a valid record id/);
  await rejects({ ...scheduled(), highlevelContactId: 'bad id!' }, /highlevelContactId is not a valid record id/);
  await rejects({ ...scheduled(), surprise: true }, /unknown field surprise/);
  await rejects({ ...scheduled(), data: { amountCents: 100 } }, /does not take amountCents/);
  await rejects({ ...scheduled(), data: { channel: 'carrier_pigeon' } }, /field channel is invalid/);
  await rejects({ ...scheduled(), data: { proposalHash: 'abc' } }, /field proposalHash is invalid/);
  await rejects({ ...scheduled(), data: { proposalRank: 4 } }, /field proposalRank is invalid/);
  await rejects({ ...scheduled(), type: 'job.cancelled', data: {} }, /needs reasonCode/);
  await rejects({ ...scheduled(), type: 'job.cancelled', data: { reasonCode: 'no_response' } }, /field reasonCode is invalid/);
  await rejects({ ...scheduled(), type: 'deal.sold', data: { amountCents: 12.5 } }, /field amountCents is invalid/);
  await rejects({ ...scheduled(), type: 'deal.sold', data: { amountCents: -100 } }, /field amountCents is invalid/);
  await rejects({ ...scheduled(), type: 'deal.sold', data: { amountCents: '100' } }, /field amountCents is invalid/);
  await rejects({ ...scheduled(), type: 'job.cancelled', data: { reasonCode: 'weather', lateCancel: 'yes' } }, /field lateCancel is invalid/);
  await rejects({ ...scheduled(), actor: { id: 'Zac B', kind: 'human' } }, /valid actor/);
  await rejects({ ...scheduled(), actor: { id: 'zacb', kind: 'robot' } }, /valid actor/);
  await rejects({ ...scheduled(), via: 'fax' }, /valid source system/);
  await rejects({ ...scheduled(), source: { collection: 'dispatchOperations' } }, /authoritative record/);
  await rejects({ ...scheduled(), idempotencyKey: { kind: 'requestId', value: 'not-a-uuid' } }, /requestId idempotency key is malformed/);
  await rejects({ ...scheduled(), idempotencyKey: randomUUID() }, /idempotency key \{kind, value\}/);
  await rejects({ ...scheduled(), idempotencyKey: { kind: 'backfill', value: 'dispatchOperations/receipt-1' } }, /Backfill events use via backfill/);
  await rejects({ ...scheduled(), clockSource: 'backfill', occurredAt: '2025-06-01T15:00:00.000Z' }, /Backfill events use via backfill/);
  await rejects({ ...scheduled(), idempotencyKey: { kind: 'derived', value: 'x:1' } }, /system events only/);
  await rejects({ ...scheduled(), occurredAt: '2026-09-22T11:00:00.000Z' }, /Server-clock events take the server time/);
  await rejects({ ...scheduled(), clockSource: 'provider' }, /provider event needs an ISO occurredAt/);
  await rejects({ ...scheduled(), clockSource: 'provider', occurredAt: '2026-09-22T12:06:00.000Z' }, /outside the accepted range/);
  await rejects({ ...scheduled(), clockSource: 'attested', occurredAt: '1999-12-31T23:59:59.000Z' }, /outside the accepted range/);
  await rejects({ ...scheduled(), clockSource: 'device_validated', occurredAt: NOW }, /must come from deviceAt/);
  await rejects({ ...scheduled(), clockSource: 'sundial' }, /clock source is not defined/);
  await rejects({ ...scheduled(), data: 'channel=hub_phone' }, /data must be an object/);
  await rejects(null, /must be an object/);
});

test('every defined event type accepts its required fields, so the vocabulary is self-consistent', async () => {
  const { eventTypes, dataFields, reasonCodes } = funnelDefinitions();
  const sample = (name, spec) => {
    const field = dataFields[name];
    if (field.type === 'cents') return 12500;
    if (field.type === 'integer') return field.min;
    if (field.type === 'boolean') return true;
    if (field.type === 'slug') return 'scheduled';
    if (field.type === 'sha256') return 'a'.repeat(64);
    if (field.type === 'reasonCode') return reasonCodes[spec.reasons][0];
    return field.values.split('.').reduce((node, key) => node[key], funnelDefinitions())[0];
  };
  const ids = { projectId: 'project_1', jobId: 'job-1', walkthroughId: 'walk-1', customerId: 'customer-1', businessAccountId: 'acct-1', inquiryId: 'inq-1', membershipId: 'sub_1', highlevelContactId: 'contact1', highlevelOpportunityId: 'opp1' };
  for (const [type, spec] of Object.entries(eventTypes)) {
    const entity = spec.entity[0], records = entity === 'walkthroughId' ? { hub: { id: 'walk-1', type: 'walkthrough' } } : entity === 'jobId' ? { hub: job() } : {};
    const data = Object.fromEntries([...spec.required, ...spec.optional].map(name => [name, sample(name, spec)]));
    const write = await funnelEventWrite(null, NOW, { type, idempotencyKey: { kind: 'requestId', value: randomUUID() }, [entity]: ids[entity], actor: owner, via: 'hub', source: { collection: 'hubOperations', id: 'receipt-1' }, data, eligibility: records });
    assert.equal(write.patch.type, type); assert.equal(write.patch.entityKey, `${entity}:${ids[entity]}`); assert.deepEqual(Object.keys(write.patch.data), Object.keys(data).sort());
  }
});

test('isTest and isInternal come only from the shared eligibility function, and private records never get events', async () => {
  await assert.rejects(funnelEventWrite(null, NOW, { ...scheduled(), eligibility: {} }), /must pass that record as eligibility\.hub/);
  await assert.rejects(funnelEventWrite(null, NOW, { ...scheduled(), eligibility: { hub: job('job-2') } }), /must pass that record as eligibility\.hub/);
  await assert.rejects(funnelEventWrite(null, NOW, { ...scheduled(), eligibility: { hub: { ...job(), recordType: 'schedule_lock' } } }), error => error.code === 'funnel_event_private_record');
  const tested = await funnelEventWrite(null, NOW, { ...scheduled(), eligibility: { hub: job('job-1', { isTest: true }) } });
  assert.deepEqual([tested.patch.isTest, tested.patch.isInternal, tested.patch.exclusion], [true, false, 'test']);
  const internal = await funnelEventWrite(null, NOW, { ...scheduled(), eligibility: { hub: job('job-1', { isInternal: true, internalReason: 'owner_own' }) } });
  assert.deepEqual([internal.patch.isTest, internal.patch.isInternal, internal.patch.internalReason, internal.patch.exclusion], [false, true, 'owner_own', 'internal']);
  const withContact = await funnelEventWrite(null, NOW, { ...scheduled(), highlevelContactId: 'contact1', eligibility: { hub: job(), ghl: { tags: ['routing-canary'] } } });
  assert.deepEqual([withContact.patch.isTest, withContact.patch.exclusion], [true, 'test']);
  const payment = { type: 'payment.received', idempotencyKey: { kind: 'stripeEvent', value: 'evt_1SyntheticEvent' }, jobId: 'job-1', actor: { id: 'stripe-webhook', kind: 'integration', role: 'integration' }, via: 'stripe', clockSource: 'provider', occurredAt: '2026-09-22T11:59:00.000Z', source: { collection: 'stripe_events', id: 'evt_1SyntheticEvent' }, data: { amountCents: 70000, kind: 'deposit', method: 'card' } };
  await assert.rejects(funnelEventWrite(null, NOW, { ...payment, eligibility: { hub: job() } }), /Stripe object for eligibility/);
  const live = await funnelEventWrite(null, NOW, { ...payment, eligibility: { hub: job(), stripe: { id: 'evt_1SyntheticEvent', livemode: true } } });
  assert.deepEqual([live.patch.clockSource, live.patch.occurredAt, live.patch.isTest], ['provider', '2026-09-22T11:59:00.000Z', false]);
  const sandbox = await funnelEventWrite(null, NOW, { ...payment, idempotencyKey: { kind: 'stripeSession', value: 'cs_test_a1B2c3D4' }, eligibility: { hub: job(), stripe: { sessionId: 'cs_test_a1B2c3D4' } } });
  assert.deepEqual([sandbox.patch.isTest, sandbox.patch.exclusion], [true, 'stripe_test_mode']);
  // eligibility.hub must be a record the event carries; an absent entity (null) never matches.
  const sent = { type: 'quote.sent', idempotencyKey: { kind: 'requestId', value: randomUUID() }, projectId: 'project_w1', actor: owner, via: 'hub', source: { collection: 'moneyOperations', id: 'receipt-1' } };
  for (const hub of [{ id: null, isTest: true }, { isTest: true }, { id: '' }, { id: 7 }, { id: 'job-1' }, { id: 'project_other' }, null]) {
    await assert.rejects(funnelEventWrite(null, NOW, { ...sent, eligibility: { hub } }), /must be one of the event records/, JSON.stringify(hub));
  }
  assert.deepEqual((await funnelEventWrite(null, NOW, { ...sent, eligibility: { hub: { id: 'project_w1', isTest: true } } })).patch.exclusion, 'test');
  const inquiry = await funnelEventWrite(null, NOW, { type: 'inquiry.received', idempotencyKey: { kind: 'requestId', value: randomUUID() }, inquiryId: 'inq-1', actor: { id: 'web-lead', kind: 'system' }, via: 'hub', source: { collection: 'web_lead_receipts', id: 'inq-1' }, data: { origin: 'web_form' }, eligibility: { ghl: { tags: ['egc-test'] } } });
  assert.deepEqual([inquiry.patch.isTest, inquiry.patch.actor.role], [true, null]);
});

test('the device-clock rule accepts in-bounds device times and marks everything else attested, never dated outside the bounds', () => {
  const startedAt = '2026-09-22T15:00:00.000Z', now = '2026-09-22T16:00:00.000Z';
  assert.deepEqual(resolveDeviceClock({ deviceAt: '2026-09-22T15:30:00.000Z', now, startedAt }), { occurredAt: '2026-09-22T15:30:00.000Z', clockSource: 'device_validated', reasons: [] });
  assert.equal(resolveDeviceClock({ deviceAt: '2026-09-22T14:00:00.000Z', now, startedAt }).clockSource, 'device_validated', 'exactly startedAt - 1 h is in bounds');
  assert.deepEqual(resolveDeviceClock({ deviceAt: '2026-09-22T13:59:59.999Z', now, startedAt }), { occurredAt: '2026-09-22T14:00:00.000Z', clockSource: 'attested', reasons: ['device_time_before_bounds'] }, 'a time before the bounds is dated at the bound');
  assert.equal(resolveDeviceClock({ deviceAt: '2026-09-22T16:05:00.000Z', now, startedAt }).clockSource, 'device_validated', 'now + 5 min is in bounds');
  assert.deepEqual(resolveDeviceClock({ deviceAt: '2026-09-22T16:05:00.001Z', now, startedAt }), { occurredAt: now, clockSource: 'attested', reasons: ['device_time_in_future'] }, 'a future device time is never used as occurredAt');
  assert.deepEqual(resolveDeviceClock({ deviceAt: '2026-09-22T15:30:00.000Z', now }), { occurredAt: now, clockSource: 'attested', reasons: ['device_time_unbounded'] }, 'an unbounded device time is dated at the server time');
  // Scheduled date - 1 day is Denver midnight: 2026-03-09 → 2026-03-08 00:00 MST (07:00Z) on the spring-change day.
  assert.equal(resolveDeviceClock({ deviceAt: '2026-03-08T07:00:00.000Z', now: '2026-03-09T20:00:00.000Z', scheduledDate: '2026-03-09' }).clockSource, 'device_validated');
  assert.deepEqual(resolveDeviceClock({ deviceAt: '2026-03-08T06:59:59.999Z', now: '2026-03-09T20:00:00.000Z', scheduledDate: '2026-03-09' }), { occurredAt: '2026-03-08T07:00:00.000Z', clockSource: 'attested', reasons: ['device_time_before_bounds'] });
  // With both bounds the later one applies.
  assert.deepEqual(resolveDeviceClock({ deviceAt: '2026-09-22T06:30:00.000Z', now, startedAt, scheduledDate: '2026-09-22' }), { occurredAt: '2026-09-22T14:00:00.000Z', clockSource: 'attested', reasons: ['device_time_before_bounds'] });
  // A bound after the server time (a visit recorded before its scheduled day) dates the event now, never in the future.
  assert.deepEqual(resolveDeviceClock({ deviceAt: '2026-09-22T15:59:00.000Z', now, scheduledDate: '2026-09-30' }), { occurredAt: now, clockSource: 'attested', reasons: ['device_time_before_bounds'] });
  // A reset phone clock (1970) and corrupt bounds still land at or after eventIntegrity.earliestOccurredAt.
  assert.deepEqual(resolveDeviceClock({ deviceAt: '1970-01-01T00:00:00.000Z', now, startedAt }), { occurredAt: '2026-09-22T14:00:00.000Z', clockSource: 'attested', reasons: ['device_time_before_bounds'] });
  assert.deepEqual(resolveDeviceClock({ deviceAt: '1970-01-01T00:00:00.000Z', now, startedAt: '1990-01-01T00:00:00.000Z' }), { occurredAt: funnelDefinitions().eventIntegrity.earliestOccurredAt, clockSource: 'attested', reasons: ['device_time_before_bounds'] });
  assert.deepEqual(resolveDeviceClock({ deviceAt: '2099-01-01T00:00:00.000Z', now, startedAt }), { occurredAt: now, clockSource: 'attested', reasons: ['device_time_in_future'] });
  // Property: whatever the device says, occurredAt stays in [max(earliest, lower bound) or now, now + 5 min].
  const floor = Date.parse('2026-09-22T14:00:00.000Z'), nowMs = Date.parse(now);
  for (let device = Date.UTC(1969, 0, 1); device < Date.UTC(2030, 0, 1); device += 7 * 86400000 + 12345) {
    const resolved = resolveDeviceClock({ deviceAt: new Date(device).toISOString(), now, startedAt }), at = Date.parse(resolved.occurredAt);
    assert.ok(at >= floor && at <= nowMs + 5 * 60000, resolved.occurredAt);
    assert.equal(resolved.clockSource === 'device_validated', device >= floor && device <= nowMs + 5 * 60000);
  }
  assert.throws(() => resolveDeviceClock({ deviceAt: 'soon', now }), error => error.code === 'funnel_event_invalid');
  assert.throws(() => resolveDeviceClock({ deviceAt: now, now, scheduledDate: '2026-02-30' }), error => error.code === 'funnel_event_invalid');
});

test('walkthrough events carry device provenance through funnelEventWrite', async () => {
  const walk = { id: 'walk-1', type: 'walkthrough', date: '2026-09-22' };
  const base = { type: 'walkthrough.completed', idempotencyKey: { kind: 'requestId', value: randomUUID() }, walkthroughId: 'walk-1', projectId: 'project_walk-1', actor: { id: 'sales1', kind: 'human', role: 'sales' }, via: 'field', source: { collection: 'jobs', id: 'walk-1' }, data: { outcome: 'not_interested', reasonCode: 'price', recordingStatus: 'declined' }, eligibility: { hub: walk } };
  const validated = await funnelEventWrite(null, '2026-09-22T17:00:00.000Z', { ...base, deviceAt: '2026-09-22T10:58:00-06:00', deviceBounds: { startedAt: '2026-09-22T16:00:00.000Z', scheduledDate: '2026-09-22' } });
  assert.deepEqual([validated.patch.clockSource, validated.patch.occurredAt, validated.patch.deviceAt], ['device_validated', '2026-09-22T16:58:00.000Z', '2026-09-22T16:58:00.000Z']);
  const skewed = await funnelEventWrite(null, '2026-09-22T17:00:00.000Z', { ...base, deviceAt: '2026-09-23T09:00:00.000Z', deviceBounds: { startedAt: '2026-09-22T16:00:00.000Z' } });
  assert.deepEqual([skewed.patch.clockSource, skewed.patch.occurredAt, skewed.patch.deviceAt, skewed.patch.clockReasons], ['attested', '2026-09-22T17:00:00.000Z', '2026-09-23T09:00:00.000Z', ['device_time_in_future']]);
  assert.equal(validated.id, skewed.id, 'the id depends on type, entity and key only');
  assert.notEqual(validated.patch.fingerprint, skewed.patch.fingerprint, 'but a different device time is a different event');
  await assert.rejects(funnelEventWrite(null, NOW, { ...base, deviceAt: NOW, clockSource: 'attested' }), /replaces clockSource/);
  await assert.rejects(funnelEventWrite(null, NOW, { ...base, deviceBounds: { startedAt: NOW } }), /must come from deviceAt/);
  await assert.rejects(funnelEventWrite(null, NOW, { ...base, deviceAt: NOW, deviceBounds: { startedAt: NOW, crew: 'x' } }), /Device bounds are/);
  await assert.rejects(funnelEventWrite(null, NOW, { ...base, data: { outcome: 'not_interested', reasonCode: 'weather' } }), /field reasonCode is invalid/, 'walkthrough outcomes take lost reasons');
});

test('a skewed or reset phone clock can neither move a sale into another period nor refuse the commit (C17)', async () => {
  const now = '2026-09-30T18:00:00.000Z', deviceBounds = { startedAt: '2026-09-30T16:00:00.000Z', scheduledDate: '2026-09-30' };
  const sold = { type: 'deal.sold', idempotencyKey: { kind: 'requestId', value: randomUUID() }, jobId: 'job-1', projectId: 'project_w1', actor: { id: 'sales1', kind: 'human', role: 'sales' }, via: 'field', source: { collection: 'walkthroughHandoffs', id: 'handoff-1' }, data: { amountCents: 480000, estimateRevision: 1 }, eligibility: { hub: job() } };
  const mtd = funnelPeriod('mtd', now), lastMonth = funnelPeriod('last_month', now);
  // A phone a month behind: dated at the bound (startedAt - 1 h), today in Denver, in this month's revenue.
  const backdated = await funnelEventWrite(null, now, { ...sold, deviceAt: '2026-08-31T18:00:00.000Z', deviceBounds });
  assert.deepEqual([backdated.patch.clockSource, backdated.patch.clockReasons, backdated.patch.occurredAt, backdated.patch.denverDate, backdated.patch.deviceAt], ['attested', ['device_time_before_bounds'], '2026-09-30T15:00:00.000Z', '2026-09-30', '2026-08-31T18:00:00.000Z']);
  assert.ok(backdated.patch.occurredAt >= mtd.startAt && backdated.patch.occurredAt < mtd.elapsedThrough, 'counted in month to date');
  assert.ok(backdated.patch.occurredAt >= lastMonth.endAt, 'never in last month');
  // A phone reset to 1970 records the sale (attested, at the bound) instead of failing the whole commit.
  const reset = await funnelEventWrite(null, now, { ...sold, deviceAt: '1970-01-01T00:00:00.000Z', deviceBounds });
  assert.deepEqual([reset.patch.clockSource, reset.patch.occurredAt, reset.patch.denverDate, reset.patch.deviceAt], ['attested', '2026-09-30T15:00:00.000Z', '2026-09-30', '1970-01-01T00:00:00.000Z']);
  const store = memoryStore({ 'jobs/job-1': job() }), current = await store.read('jobs', 'job-1');
  await store.commit([{ collection: 'jobs', id: 'job-1', revision: current.revision, patch: { customerApproval: { status: 'approved' } } }, reset]);
  assert.equal(store.rows.get(`funnelEvents/${reset.id}`).occurredAt, '2026-09-30T15:00:00.000Z');
  // Without bounds the device time is kept only for review and the sale is dated at the server time.
  const unbounded = await funnelEventWrite(null, now, { ...sold, deviceAt: '1970-01-01T00:00:00.000Z' });
  assert.deepEqual([unbounded.patch.clockSource, unbounded.patch.clockReasons, unbounded.patch.occurredAt, unbounded.patch.deviceAt], ['attested', ['device_time_unbounded'], now, '1970-01-01T00:00:00.000Z']);
});

test('system and backfill events follow their idempotency conventions', async () => {
  const closed = await funnelEventWrite(null, NOW, { type: 'project.closed', idempotencyKey: { kind: 'derived', value: 'project.closed:project_1' }, projectId: 'project_1', actor: { id: 'reconciler', kind: 'system' }, via: 'cron', clockSource: 'system', occurredAt: '2026-09-20T22:00:00.000Z', source: { collection: 'jobs', id: 'job-1' } });
  assert.deepEqual([closed.patch.clockSource, closed.patch.occurredAt, closed.patch.denverDate], ['system', '2026-09-20T22:00:00.000Z', '2026-09-20']);
  const restated = await funnelEventWrite(null, NOW, { type: 'project.costs_restated', idempotencyKey: { kind: 'derived', value: 'project.costs_restated:project_1:r7' }, projectId: 'project_1', actor: { id: 'reconciler', kind: 'system' }, via: 'cron', clockSource: 'system', source: { collection: 'projects', id: 'project_1' } });
  assert.equal(restated.patch.occurredAt, NOW);
  const legacy = await funnelEventWrite(null, NOW, { type: 'job.no_show', idempotencyKey: { kind: 'backfill', value: 'dispatchOperations/legacy-1' }, jobId: 'job-1', actor: { id: 'backfill', kind: 'system' }, via: 'backfill', clockSource: 'backfill', occurredAt: '2025-06-01T15:00:00.000Z', source: { collection: 'dispatchOperations', id: 'legacy-1' }, data: { reasonCode: 'other_legacy' }, eligibility: { hub: job() } });
  assert.deepEqual([legacy.patch.idempotencyKey, legacy.patch.clockSource, legacy.patch.denverDate], ['backfill:dispatchOperations/legacy-1', 'backfill', '2025-06-01']);
  await assert.rejects(funnelEventWrite(null, NOW, { type: 'job.no_show', idempotencyKey: { kind: 'backfill', value: 'dispatchOperations/other' }, jobId: 'job-1', actor: { id: 'backfill', kind: 'system' }, via: 'backfill', clockSource: 'backfill', occurredAt: '2025-06-01T15:00:00.000Z', source: { collection: 'dispatchOperations', id: 'legacy-1' }, eligibility: { hub: job() } }), /source\.collection\/source\.id/);
  // §4.1: browser-written history is imported as attested and Stripe history keeps the provider clock; a live clock never backfills.
  const imported = (clockSource, extra = {}) => funnelEventWrite(null, NOW, { type: 'payment.received', idempotencyKey: { kind: 'backfill', value: 'jobs/job-1' }, jobId: 'job-1', actor: { id: 'backfill', kind: 'system' }, via: 'backfill', clockSource, occurredAt: '2025-06-02T15:00:00.000Z', source: { collection: 'jobs', id: 'job-1' }, data: { amountCents: 25000, kind: 'offline', method: 'check' }, eligibility: { hub: job() }, ...extra });
  const attested = await imported('attested');
  assert.deepEqual([attested.patch.via, attested.patch.clockSource, attested.patch.occurredAt, attested.patch.idempotencyKey], ['backfill', 'attested', '2025-06-02T15:00:00.000Z', 'backfill:jobs/job-1']);
  assert.equal((await imported('provider')).patch.clockSource, 'provider');
  for (const clockSource of ['server', 'system']) await assert.rejects(imported(clockSource, { occurredAt: undefined }), /Backfill events use via backfill/, clockSource);
  await assert.rejects(imported('attested', { idempotencyKey: { kind: 'requestId', value: randomUUID() } }), /Backfill events use via backfill/, 'a backfill always uses the backfill key');
});

test('backfill events from sub-records of one source document get distinct ids (source.id <docId>:<field>:<subId>)', async () => {
  const payment = (sourceId, amountCents) => ({ type: 'payment.received', idempotencyKey: { kind: 'backfill', value: `jobs/${sourceId}` }, jobId: 'job-1', actor: { id: 'backfill', kind: 'system' }, via: 'backfill', clockSource: 'provider', occurredAt: '2025-06-02T15:00:00.000Z', source: { collection: 'jobs', id: sourceId }, data: { amountCents, kind: 'deposit', method: 'card' }, eligibility: { hub: job() } });
  assert.match(funnelDefinitions().eventIntegrity.idempotencyKeys.backfill.use, /<docId>:<field>:<subId>/);
  const store = memoryStore({ 'jobs/job-1': job() });
  // Keyed by the whole job document, a second Stripe session on the same job collides with the first.
  await store.commit([await funnelEventWrite(store, NOW, payment('job-1', 25000))]);
  await assert.rejects(funnelEventWrite(store, NOW, payment('job-1', 15000)), error => error.code === 'funnel_event_idempotency_conflict');
  // Naming each session as a sub-record gives each its own event, and a re-run finds both already saved.
  const first = await funnelEventWrite(store, NOW, payment('job-1:stripeSessions:cs_live_a1B2c3D4', 25000));
  const second = await funnelEventWrite(store, NOW, payment('job-1:stripeSessions:cs_live_e5F6g7H8', 15000));
  assert.notEqual(first.id, second.id);
  assert.deepEqual([first.patch.idempotencyKey, second.patch.source], ['backfill:jobs/job-1:stripeSessions:cs_live_a1B2c3D4', { collection: 'jobs', id: 'job-1:stripeSessions:cs_live_e5F6g7H8' }]);
  await store.commit([first, second]);
  assert.deepEqual(await Promise.all(['job-1:stripeSessions:cs_live_a1B2c3D4', 'job-1:stripeSessions:cs_live_e5F6g7H8'].map((id, index) => funnelEventWrite(store, NOW, payment(id, [25000, 15000][index])))), [null, null]);
});

test('funnelEvents is server-only in the rules and its composite indexes (including the FUN-37 filtered feed) are declared for deployment', () => {
  const rules = read('firestore.rules');
  assert.match(rules, /match \/funnelEvents\/\{documentId\} \{\s*allow read, write: if false;\s*\}/);
  assert.equal(JSON.parse(read('firebase.json')).firestore.indexes, 'firestore.indexes.json');
  const indexes = JSON.parse(read('firestore.indexes.json')).indexes.filter(index => index.collectionGroup === FUNNEL_EVENTS_COLLECTION);
  assert.deepEqual(indexes.map(index => index.fields.map(field => field.fieldPath)), FUNNEL_EVENT_INDEXES.map(index => [...index]));
  for (const index of indexes) { assert.equal(index.queryScope, 'COLLECTION'); assert.ok(index.fields.every(field => field.order === 'ASCENDING')); }
  assert.ok(FUNNEL_EVENT_INDEXES.some(index => index.join() === 'type,recordedAt'), 'type in [...] order by recordedAt needs (type, recordedAt)');
});
