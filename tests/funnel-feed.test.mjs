import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { HUB_COMMAND_POLICY, HUB_FUNNEL_CASE_CURSOR_PATTERN, HUB_FUNNEL_FEED_CURSOR_PATTERN, HUB_FUNNEL_MAX_TYPES, HUB_FUNNEL_PAGE_LIMIT } from '../egc-platform/services/operations/src/hub-command-policy.ts';
import { FUNNEL_CASE_CURSOR_MAX_AGE_MS, FUNNEL_CASE_CURSOR_SKEW_MS, FUNNEL_FEED_SETTLE_MS, WALKTHROUGH_OUTCOME_EVENT_TYPES, feedCursor, feedDataFields, funnelCase, funnelCaseInput, funnelEventsFeed, funnelEventsInput, funnelFeedStorage, privateFieldName, projectFunnelEvent, walkthroughOutcomesFeed, walkthroughOutcomesInput } from '../functions/_lib/funnel-feed.js';
import { HUB_COMMAND_REGISTRY, runHubCommand } from '../functions/_lib/operations-hub-commands.js';
import { OPERATIONS_COMMAND_POLICY, authorizeCommand } from '../functions/_lib/operations-command-policy.js';
import { funnelEventWrite } from '../functions/_lib/funnel-events.js';
import { definitionsHash, funnelDefinitions } from '../functions/_lib/funnel-definitions.js';
import { recordWalkthroughVisit, WALKTHROUGH_VISIT_OPERATIONS } from '../functions/_lib/walkthrough-visit.js';
import { saveWalkthroughHandoff } from '../functions/_lib/walkthrough-handoff.js';
import { encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { signOperationsEnvelope } from '../functions/_lib/operations-envelope.js';
import { mutateDispatch } from '../functions/_lib/dispatch-service.js';
import { PORTAL_COMMANDS, onRequestPost as portal } from '../functions/api/operations-portal.js';

// FUN-37: the bridge funnel event feed. Events come from the real writers
// (funnelEventWrite, FUN-05 walkthrough visits, FUN-02 handoffs) into an
// in-memory Firestore; the clock is always injected, never the real one.
const T0 = '2026-09-22T18:00:00.000Z', at = (base, ms) => new Date(Date.parse(base) + ms).toISOString();
const MIN = 60000, SETTLED = FUNNEL_FEED_SETTLE_MS;
const FIRESTORE_TIME = '2026-09-22T19:00:00.000001Z';
const owner = { user: 'zacb', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true };
const ROSTER = [{ id: 'zacb', name: 'Synthetic Owner', role: 'owner' }, { id: 'crew1', name: 'Synthetic Crew', role: 'crew' }];
const conflict = () => Object.assign(new Error('Conflict'), { code: 'dispatch_revision_conflict', status: 409 });
const rejectsCode = (promise, code, status) => assert.rejects(promise, error => { assert.equal(error.code, code); if (status) assert.equal(error.status, status); return true; });
const throwsCode = (fn, code, status = 400) => assert.throws(fn, error => error.code === code && error.status === status);
const byPosition = order => (a, b) => a[order] < b[order] ? -1 : a[order] > b[order] ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
// Request ids, idempotency keys, source ids and envelope nonces: unique per call (the writers'
// replay and idempotency rules are unchanged) but the same on every run. Event ids are sha256 of
// the idempotency key, so random keys made random 40-hex ids that now and then contained a leak
// probe such as '7777' or '1437' and failed the no-secret checks. The v4 shape passes the
// writers' UUID checks; the letters keep request.toUpperCase() a different string.
let uuids = 0;
const testUUID = () => `feed0000-0000-4000-8000-${(++uuids).toString(16).padStart(12, '0')}`;

// In-memory Firestore: create-only without a revision, compare-and-set with one, all or
// nothing. Every commit is stamped with the store's Firestore clock, so a query or record
// read at a pinned readTime sees exactly the documents as committed by then (like runQuery
// and batchGet readTime); an unpinned read sees the current rows.
function ledger(seed = {}) {
  const rows = new Map(), stamps = new Map(), versions = new Map(), SEEDED = '2026-09-01T00:00:00.000001Z'; let n = 0;
  for (const [key, value] of Object.entries(seed)) { rows.set(key, { revision: `${key}-r0`, ...structuredClone(value), id: key.split('/')[1] }); stamps.set(key, SEEDED); versions.set(key, [{ stamp: SEEDED, row: structuredClone(rows.get(key)) }]); }
  const list = prefix => [...rows].filter(([key]) => key.startsWith(`${prefix}/`)).map(([, value]) => structuredClone(value));
  const readAt = (key, readTime) => !readTime || readTime >= store.clock ? rows.get(key) : (versions.get(key) || []).filter(version => version.stamp <= readTime).at(-1)?.row;
  const masked = (row, fields) => ({ id: row.id, ...Object.fromEntries(fields.filter(field => row[field] !== undefined).map(field => [field, structuredClone(row[field])])) });
  const store = {
    rows, stamps, clock: FIRESTORE_TIME, queries: [], recordReads: [], commits: [], env: {},
    jobs: async () => list('jobs'), resources: async () => list('dispatchResources'), roster: async () => structuredClone(ROSTER),
    customers: async provider => provider === undefined ? list('customers') : list('customers').filter(row => row.highlevelContactId === provider),
    day: async date => list('jobs').filter(row => row.date === date), snapshot: async () => list('jobs').filter(row => !row.recordType), identityCandidates: async () => [],
    assigned: async (session, job) => (job.assignedCrew || []).includes(session.user.toLowerCase()),
    read: async (collection, id) => structuredClone(rows.get(`${collection}/${id}`) || null),
    async commit(writes) {
      const keys = writes.map(write => `${write.collection}/${write.id}`);
      assert.equal(new Set(keys).size, keys.length, 'a commit never writes one document twice');
      for (const write of writes) { const old = rows.get(`${write.collection}/${write.id}`); if (write.revision ? old?.revision !== write.revision : old) throw conflict(); }
      for (const write of writes) if (!write.verify) {
        const key = `${write.collection}/${write.id}`;
        rows.set(key, { ...(write.revision ? rows.get(key) : {}), ...structuredClone(write.patch), id: write.id, revision: `r${++n}` }); stamps.set(key, store.clock);
        versions.set(key, [...(versions.get(key) || []), { stamp: store.clock, row: structuredClone(rows.get(key)) }]);
      }
      store.commits.push(keys);
    },
    // The feed storage contract (funnelFeedStorage), with Firestore's query semantics.
    async funnelEventsPage(query) {
      store.queries.push(structuredClone(query));
      const readTime = query.readTime || store.clock;
      const visible = [...rows].filter(([key]) => key.startsWith('funnelEvents/') && stamps.get(key) <= readTime).map(([, row]) => structuredClone(row));
      const found = visible.filter(row => typeof row[query.order] === 'string' && (!query.types || query.types.includes(row.type)) && (!query.anyOf || query.anyOf.some(match => row[match.field] === match.value)) && (!query.through || row[query.order] <= query.through))
        .sort(byPosition(query.order)).filter(row => !query.after || row[query.order] > query.after.at || row[query.order] === query.after.at && row.id > query.after.id);
      return { rows: found.slice(0, query.limit), readTime };
    },
    async funnelRecords(collection, ids, fields, readTime = null) {
      store.recordReads.push({ collection, ids: [...ids], readTime });
      return { rows: ids.map(id => readAt(`${collection}/${id}`, readTime)).filter(Boolean).map(row => masked(row, fields)), readTime: readTime || store.clock };
    },
  };
  store.events = type => list('funnelEvents').filter(event => !type || event.type === type);
  return store;
}

const job = (id, extra = {}) => ({ id, type: 'job', status: 'scheduled', customerId: 'c1', projectId: 'project_a', highlevelContactId: 'contactA', ...extra });
function jobEvent(type, record, data = {}, extra = {}) {
  return { type, idempotencyKey: { kind: 'requestId', value: testUUID() }, jobId: record.id, ...(record.projectId ? { projectId: record.projectId } : {}), ...(record.highlevelContactId ? { highlevelContactId: record.highlevelContactId } : {}), customerId: 'c1',
    actor: { id: 'zacb', kind: 'human', role: 'owner' }, via: 'hub', source: { collection: 'dispatchOperations', id: testUUID() }, data, eligibility: { hub: record }, ...extra };
}
async function emit(store, clock, ...events) {
  const writes = []; for (const event of events) writes.push(await funnelEventWrite(null, clock, event));
  await store.commit(writes);
  return writes.map(write => store.rows.get(`funnelEvents/${write.id}`));
}
const feed = (store, input, now) => funnelEventsFeed(store, funnelEventsInput(input), new Date(now));

test('the three funnel commands are owner/manager reads with delegated integrations in the one bridge policy table', () => {
  for (const name of ['hub.funnel.events', 'hub.walkthrough.outcomes', 'hub.funnel.case']) {
    assert.deepEqual({ ...HUB_COMMAND_POLICY[name], roles: [...HUB_COMMAND_POLICY[name].roles] }, { write: false, integrationAllowed: true, roles: ['owner', 'manager'], ownerOnly: false, confirmRequired: false, revisioned: false }, name);
    const { input, handler, ...policy } = HUB_COMMAND_REGISTRY[name];
    assert.deepEqual(policy, { ...HUB_COMMAND_POLICY[name] }); assert.equal(typeof input, 'function'); assert.equal(typeof handler, 'function');
    // The union table the signed endpoints authorize against (BRIDGE-AUTHZ) carries it as a read.
    assert.deepEqual(OPERATIONS_COMMAND_POLICY[name], { kind: 'read', confirm: false, confirmed: false, actors: [{ kind: 'human', role: 'owner' }, { kind: 'human', role: 'manager' }, { kind: 'integration', role: 'integration', delegate: true }] });
    assert.equal(PORTAL_COMMANDS.includes(name), false, 'hub.* commands are routed by the registry, never the legacy allowlist');
    const PORTAL = { commands: PORTAL_COMMANDS, hub: true, unknown: 'read_only_portal_command_required' };
    for (const role of ['owner', 'manager']) assert.equal(authorizeCommand({ id: 'x', kind: 'human', role, workspace: 'egc' }, { command: name }, PORTAL).kind, 'read');
    for (const role of ['sales', 'crew', 'crew_lead']) throwsCode(() => authorizeCommand({ id: 'x', kind: 'human', role, workspace: 'egc' }, { command: name }, PORTAL), 'hub_role_forbidden', 403);
    throwsCode(() => authorizeCommand({ id: 'walkthrough-followup', kind: 'integration', role: 'integration', workspace: 'egc' }, { command: name }, PORTAL), 'hub_delegate_required', 403);
    assert.equal(authorizeCommand({ id: 'walkthrough-followup', kind: 'integration', role: 'integration', workspace: 'egc' }, { command: name, delegate: 'zacb' }, PORTAL).kind, 'read');
  }
  assert.equal(HUB_FUNNEL_PAGE_LIMIT, 200); assert.equal(HUB_FUNNEL_MAX_TYPES, 30);
  // The shared cursor patterns name exactly the funnel event id format the Hub writes.
  const rules = funnelDefinitions().eventIntegrity.eventId;
  assert.deepEqual([rules.prefix, rules.hexLength], ['fe_', 40]);
  assert.match(`f1~${T0}~fe_${'a'.repeat(40)}`, HUB_FUNNEL_FEED_CURSOR_PATTERN);
});

test('the feed pages the ledger by (recordedAt, id) exactly once each, including events of one commit that share recordedAt', async () => {
  const store = ledger(), a = job('job-a'), b = job('job-b', { projectId: 'project_b' });
  const first = await emit(store, T0, jobEvent('job.scheduled', a, { channel: 'hub_phone', occurrence: 1 }), jobEvent('job.assigned', a), jobEvent('job.scheduled', b));
  const second = await emit(store, at(T0, 1000), jobEvent('deal.sold', a, { amountCents: 140000, estimateRevision: 1 }));
  const third = await emit(store, at(T0, 2000), jobEvent('job.completed', b, { fromStatus: 'in_progress', toStatus: 'completed' }));
  const expected = [...first.sort(byPosition('recordedAt')), ...second, ...third].map(row => row.id);
  const now = at(T0, 2000 + SETTLED);
  const whole = await feed(store, {}, now);
  assert.deepEqual(whole.events.map(event => event.id), expected);
  assert.deepEqual([whole.hasMore, whole.nextCursor, whole.settledThrough, whole.asOf, whole.definitionsHash], [false, `f1~${third[0].recordedAt}~${third[0].id}`, at(T0, 2000), FIRESTORE_TIME, definitionsHash()]);
  assert.deepEqual(whole.coverage, { complete: true, asOf: FIRESTORE_TIME, through: at(T0, 2000) });
  // One event per page: every cursor resumes strictly after the last delivered event.
  const seen = []; let cursor = null, pages = 0;
  do {
    const page = await feed(store, { sinceCursor: cursor, limit: 1 }, now);
    seen.push(...page.events.map(event => event.id)); cursor = page.nextCursor; pages++;
    assert.equal(page.events[0]?.cursor ?? cursor, cursor);
    if (!page.hasMore) break;
  } while (pages < 10);
  assert.deepEqual(seen, expected); assert.equal(pages, 5);
  const done = await feed(store, { sinceCursor: cursor }, now);
  assert.deepEqual([done.events, done.nextCursor, done.hasMore], [[], cursor, false], 'a caught-up consumer keeps its cursor');
  // types[] narrows the same cursor space; the query asks the store for limit+1 rows.
  const sold = await feed(store, { types: ['deal.sold', 'job.completed'], limit: 1 }, now);
  assert.deepEqual([sold.events.map(event => event.type), sold.hasMore], [['deal.sold'], true]);
  assert.deepEqual(store.queries.at(-1), { order: 'recordedAt', types: ['deal.sold', 'job.completed'], anyOf: null, through: at(T0, 2000), after: null, limit: 2, readTime: null });
});

test('only settled events are served, so an event that commits after a later-stamped one is never skipped', async () => {
  const store = ledger(), a = job('job-a'), b = job('job-b');
  // B is stamped a second after A but commits first; A's commit lands 30 s after its stamp.
  const [late] = [await funnelEventWrite(null, T0, jobEvent('job.scheduled', a))];
  const [early] = await emit(store, at(T0, 1000), jobEvent('job.scheduled', b));
  const beforeA = await feed(store, {}, at(T0, 20000));
  assert.deepEqual([beforeA.events.length, beforeA.nextCursor, beforeA.settledThrough], [0, null, at(T0, 20000 - SETTLED)], 'nothing inside the settle window is served');
  await store.commit([late]);
  const page = await feed(store, {}, at(T0, 1000 + SETTLED));
  assert.deepEqual(page.events.map(event => event.id), [late.id, early.id]);
  // Right at the horizon: an event stamped after settledThrough waits for the next read.
  const edge = await feed(store, {}, at(T0, 999 + SETTLED));
  assert.deepEqual(edge.events.map(event => event.id), [late.id]);
  const next = await feed(store, { sinceCursor: edge.nextCursor }, at(T0, 1000 + SETTLED));
  assert.deepEqual(next.events.map(event => event.id), [early.id]);
});

test('feed projections are allowlists: no cost, pay, fee or margin field, no fingerprints and no private ids', async () => {
  // Every defined data field is shared except the ones named like private pay data. FUN-33's tipCents (a crew tip on a
  // card charge) is one: it is crew-pay data and never leaves the Hub feed.
  const defined = Object.keys(funnelDefinitions().dataFields);
  assert.deepEqual(feedDataFields(), defined.filter(name => !privateFieldName(name)));
  assert.deepEqual(defined.filter(privateFieldName), ['tipCents'], 'tipCents is the only defined data field kept in the Hub');
  assert.equal(feedDataFields().includes('tipCents'), false);
  for (const name of ['costCents', 'laborCostCents', 'stripeFeeCents', 'feeCents', 'marginCents', 'grossMarginPct', 'payRate', 'hourlyRate', 'payType', 'wageCents', 'contributionCents', 'profitCents', 'burdenCents', 'overtimePremiumCents', 'tipCents', 'commissionCents', 'labor_cents', 'COST'])
    assert.equal(privateFieldName(name), true, name);
  for (const name of ['amountCents', 'estimateRevision', 'kind', 'method', 'proposalRank', 'paymentMethod', 'occurrence', 'lateCancel', 'score']) assert.equal(privateFieldName(name), false, name);
  const store = ledger(), a = job('job-a');
  const [event] = await emit(store, T0, jobEvent('payment.received', a, { amountCents: 25000, kind: 'deposit', method: 'card' }));
  // A row carrying private figures (as a future writer might) still never leaves the Hub.
  store.rows.set(`funnelEvents/${event.id}`, { ...event, data: { ...event.data, costCents: 777701, stripeFeeCents: 777702, marginCents: 777703, payRate: 777704, laborCents: 777705 }, hourlyRate: 777706, laborCostCents: 777707, fingerprint: 'f'.repeat(64), idempotencyKey: 'requestId:secret', jobId: 'secure_vault', source: { collection: 'jobs', id: '_egc_receipt_x' } });
  const page = await feed(store, {}, at(T0, SETTLED));
  const text = JSON.stringify(page);
  for (const secret of ['7777', 'fingerprint', 'idempotencyKey', 'hourlyRate', 'laborCost', 'secure_vault', 'requestId:secret', '_egc_receipt']) assert.equal(text.includes(secret), false, secret);
  const [projected] = page.events;
  assert.deepEqual(projected.data, { amountCents: 25000, kind: 'deposit', method: 'card' });
  assert.equal(projected.jobId, null, 'a private id is never echoed');
  assert.deepEqual(Object.keys(projected).sort(), ['actor', 'businessAccountId', 'clockReasons', 'clockSource', 'cursor', 'customerId', 'data', 'definitionsHash', 'definitionsVersion', 'denverDate', 'deviceAt', 'eligible', 'entityKey', 'exclusion', 'group', 'highlevelContactId', 'highlevelOpportunityId', 'id', 'inquiryId', 'internalReason', 'isInternal', 'isTest', 'jobId', 'membershipId', 'occurredAt', 'projectId', 'recordedAt', 'schemaVersion', 'source', 'type', 'via', 'walkthroughId']);
  assert.deepEqual([projected.actor, projected.via, projected.source, projected.eligible, projected.isTest], [{ id: 'zacb', kind: 'human', role: 'owner' }, 'hub', { collection: 'jobs', id: null }, true, false]);
  // The projection takes the allowed list, so a definitions field named for a cost is dropped automatically.
  assert.deepEqual(projectFunnelEvent({ ...event, data: { amountCents: 1, feeCents: 2 } }, ['amountCents', 'feeCents'].filter(name => !privateFieldName(name))).data, { amountCents: 1 });
  // FUN-33: a tipped card charge's payment.received keeps its crew tip in the Hub; the feed serves only the service money.
  assert.deepEqual(projectFunnelEvent({ ...event, data: { amountCents: 50000, kind: 'balance', method: 'card', cash: true, tipCents: 7500 } }, feedDataFields()).data, { amountCents: 50000, kind: 'balance', method: 'card', cash: true });
  // A source id is shown only when it is neither a private record nor the event's idempotency key (a request receipt).
  const request = testUUID();
  for (const [source, idempotencyKey, shown] of [
    [{ collection: 'dispatchOperations', id: request }, `requestId:${request}`, null], [{ collection: 'walkthroughVisitOperations', id: request.toUpperCase() }, `requestId:${request}`, null],
    [{ collection: 'jobs', id: '_egc_receipt_x' }, 'backfill:jobs/_egc_receipt_x', null], [{ collection: 'jobs', id: '_egc_receipt_x:stripeSessions:cs_live_abcdef' }, 'backfill:jobs/_egc_receipt_x:stripeSessions:cs_live_abcdef', null],
    [{ collection: 'employees', id: 'secure_vault' }, 'derived:vault', null], [{ collection: 'portalRequests', id: 'portal-req-12345678' }, 'portalRequest:portal-req-12345678', null],
    [{ collection: 'dispatchOperations', id: 'receipt-1' }, undefined, null],
    [{ collection: 'stripeSessions', id: 'cs_live_abcdef' }, 'backfill:stripeSessions/cs_live_abcdef', 'cs_live_abcdef'], [{ collection: 'dispatchOperations', id: event.source.id }, event.idempotencyKey, event.source.id],
    // A backfill sub-record ('<docId>:<field>:<subId>') shows only its document id.
    [{ collection: 'jobs', id: 'job-1:stripeSessions:cs_live_abcdef' }, 'backfill:jobs/job-1:stripeSessions:cs_live_abcdef', 'job-1'], [{ collection: 'jobs', id: 'job-1:statusHistory:3' }, 'backfill:jobs/job-1:statusHistory:3', 'job-1'],
  ]) assert.deepEqual(projectFunnelEvent({ ...event, source, idempotencyKey }).source, { collection: source.collection, id: shown }, JSON.stringify(source));
  // A FUN-04 backfill event whose source names a Stripe Checkout session sub-record: the session id never leaves the Hub.
  const backfilled = ledger(), sessionSource = { collection: 'jobs', id: 'job-1:stripeSessions:cs_live_a1b2c3d4e5f6' };
  const [imported] = await emit(backfilled, T0, { type: 'payment.received', idempotencyKey: { kind: 'backfill', value: `${sessionSource.collection}/${sessionSource.id}` }, jobId: 'job-1', customerId: 'c1', actor: { id: 'backfill', kind: 'system' }, via: 'backfill', clockSource: 'backfill',
    occurredAt: '2026-01-02T00:00:00.000Z', source: sessionSource, data: { amountCents: 5000, kind: 'deposit', method: 'card' }, eligibility: { hub: { id: 'job-1', type: 'job' } } });
  assert.deepEqual([imported.source, imported.idempotencyKey], [sessionSource, 'backfill:jobs/job-1:stripeSessions:cs_live_a1b2c3d4e5f6'], 'the ledger row keeps the sub-record');
  const importedPage = await feed(backfilled, {}, at(T0, SETTLED)), importedText = JSON.stringify(importedPage);
  assert.deepEqual(importedPage.events.map(item => [item.id, item.via, item.source]), [[imported.id, 'backfill', { collection: 'jobs', id: 'job-1' }]]);
  for (const secret of ['cs_live_', 'a1b2c3d4e5f6', 'stripeSessions']) assert.equal(importedText.includes(secret), false, secret);
});

test('test and internal records stay in the feed, flagged by the single eligibility function', async () => {
  const store = ledger(), testJob = job('job-test', { isTest: true }), internal = job('job-internal', { isInternal: true, internalReason: 'training_demo' });
  await emit(store, T0, jobEvent('job.scheduled', testJob), jobEvent('job.scheduled', internal));
  const page = await feed(store, {}, at(T0, SETTLED));
  assert.deepEqual(page.events.map(event => [event.jobId, event.eligible, event.exclusion, event.isTest, event.isInternal, event.internalReason]).sort(), [['job-internal', false, 'internal', false, true, 'training_demo'], ['job-test', false, 'test', true, false, null]]);
});

test('feed and case inputs are strict: cursors, types, limits and case keys', async () => {
  const cursor = `f1~${T0}~fe_${'0'.repeat(40)}`;
  assert.deepEqual(funnelEventsInput({}), { sinceCursor: null, types: null, limit: 100 });
  assert.deepEqual(funnelEventsInput({ sinceCursor: cursor, types: ['job.scheduled', 'deal.sold'], limit: 200 }), { sinceCursor: cursor, types: ['deal.sold', 'job.scheduled'], limit: 200 });
  assert.deepEqual(funnelEventsInput({ sinceCursor: null }), { sinceCursor: null, types: null, limit: 100 });
  for (const input of [{ types: [] }, { types: ['job.scheduled', 'job.scheduled'] }, { types: ['job.unknown'] }, { types: ['__proto__'] }, { types: 'job.scheduled' }, { types: Array(31).fill('job.scheduled') }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { limit: '10' }, { offset: 10 }, { requestId: testUUID() }, { actor: { id: 'zacb' } }])
    throwsCode(() => funnelEventsInput(input), 'hub_command_invalid');
  for (const sinceCursor of ['', 'f1~bad', `f1~2026-02-30T00:00:00.000Z~fe_${'0'.repeat(40)}`, `f1~${T0}~fe_${'0'.repeat(39)}`, `f2~${T0}~fe_${'0'.repeat(40)}`, `f1~2026-09-22T18:00:00Z~fe_${'0'.repeat(40)}`, 42])
    throwsCode(() => funnelEventsInput({ sinceCursor }), 'hub_funnel_cursor_invalid');
  assert.deepEqual(walkthroughOutcomesInput({ sinceCursor: cursor, limit: 5 }), { sinceCursor: cursor, limit: 5 });
  throwsCode(() => walkthroughOutcomesInput({ types: ['deal.sold'] }), 'hub_command_invalid');
  assert.deepEqual(funnelCaseInput({ jobId: 'job-a' }), { jobId: 'job-a', cursor: null, limit: 100 });
  for (const input of [{}, { projectId: 'project_a', jobId: 'job-a' }, { jobId: 'secure_vault' }, { projectId: '_egc_lock' }, { jobId: '../x' }, { highlevelContactId: 'contact with spaces' }, { customerId: 'c1' }, { projectId: 'project_a', limit: 500 }])
    throwsCode(() => funnelCaseInput(input), 'hub_command_invalid');
  throwsCode(() => funnelCaseInput({ projectId: 'project_a', cursor }), 'hub_funnel_cursor_invalid');
});

test('a storage page that is out of order, outside the filter or horizon, or oversized is refused, never served as complete', async t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const store = ledger(), a = job('job-a');
  const rows = await emit(store, T0, jobEvent('job.scheduled', a), jobEvent('job.assigned', a));
  const sorted = rows.sort(byPosition('recordedAt')), now = new Date(at(T0, SETTLED));
  const faulty = page => ({ funnelEventsPage: async query => ({ readTime: FIRESTORE_TIME, ...page(query) }) });
  for (const broken of [
    () => ({ rows: [...sorted].reverse() }), () => ({ rows: [sorted[0], sorted[0]] }), () => ({ rows: [{ ...sorted[0], recordedAt: at(T0, 1) }] }),
    () => ({ rows: [{ ...sorted[0], id: 'job-a' }] }), () => ({ rows: [{ ...sorted[0], type: 'job.unknown' }] }), () => ({ rows: [sorted[0]], readTime: 'yesterday' }),
    () => ({ rows: 'none' }), query => ({ rows: Array(query.limit + 1).fill(sorted[0]) }),
  ]) await rejectsCode(funnelEventsFeed(faulty(broken), funnelEventsInput({}), now), 'hub_funnel_storage_incomplete', 503);
  await rejectsCode(funnelEventsFeed(faulty(() => ({ rows: [{ ...sorted[0], recordedAt: at(T0, 1), occurredAt: at(T0, 1) }] })), funnelEventsInput({}), new Date(at(T0, SETTLED - 1000))), 'hub_funnel_storage_incomplete', 503);
  await rejectsCode(funnelEventsFeed(faulty(() => ({ rows: [sorted[0]] })), funnelEventsInput({ types: ['deal.sold'] }), now), 'hub_funnel_storage_incomplete', 503);
  await rejectsCode(funnelEventsFeed(faulty(() => ({ rows: [sorted[0]] })), funnelEventsInput({ sinceCursor: feedCursor(sorted[1]) }), now), 'hub_funnel_storage_incomplete', 503);
  // The first row the feed cannot verify is named in the error details and the Hub log, so an owner can repair or quarantine it.
  const named = async (rows, eventId, logged) => {
    warn.mock.resetCalls();
    await assert.rejects(funnelEventsFeed(faulty(() => ({ rows })), funnelEventsInput({}), now), error => { assert.deepEqual([error.code, error.status, error.details], ['hub_funnel_storage_incomplete', 503, { eventId }]); return true; });
    assert.equal(warn.mock.callCount(), 1);
    for (const part of logged) assert.ok(warn.mock.calls[0].arguments[0].includes(part), `${part} in ${warn.mock.calls[0].arguments[0]}`);
  };
  await named([sorted[0], { ...sorted[1], type: 'job.from_a_newer_build' }], sorted[1].id, [sorted[1].id, 'job.from_a_newer_build', 'repaired or quarantined']);
  await named([{ ...sorted[0], id: 'hand-made-row' }], null, ['"hand-made-row"', 'malformed']);
  await named([{ ...sorted[0], occurredAt: 'yesterday' }], sorted[0].id, [sorted[0].id, 'malformed']);
  await named([sorted[1], sorted[0]], sorted[0].id, [sorted[0].id, 'out of order']);
  warn.mock.resetCalls();
  await rejectsCode(funnelEventsFeed(faulty(() => ({ rows: 'none' })), funnelEventsInput({}), now), 'hub_funnel_storage_incomplete', 503);
  assert.equal(warn.mock.callCount(), 0, 'a malformed response names no row');
});

// Walkthrough outcomes come from the real FUN-05 recorder and FUN-02 handoff.
const rep = { user: 'Sales.Rep', displayName: 'Synthetic Sales Rep', role: 'sales', businessAccess: false, source: 'employee-account' };
const walkthrough = (id, extra = {}) => ({ type: 'walkthrough', status: 'scheduled', pipelineStatus: 'scheduled', customerId: 'c1', customer: 'Synthetic Customer', address: '100 Fixture Lane', date: '2026-09-22', time: '09:00', endTime: '10:00', assignedCrew: ['sales.rep'], projectId: `project_${id}`, highlevelContactId: 'contactA', estimate: { amount: 1437 }, signatureData: 'SYNTHETIC-SIGNATURE', ...extra });
const plan = (acceptedAt = '2026-09-22T17:45:00.000Z', jobDate = '2026-09-24') => ({ client: { name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevel_contact_id: 'contactA' }, quote: { title: 'Garage reset', total: 1400, deposit: 700, job_date: jobDate, start_time: '09:00', end_time: '12:00', estimated_duration_min: 180 }, acceptance: { accepted_at: acceptedAt, accepted_by: 'Synthetic Customer', signature_captured: true, method: 'in_person_signature', terms_version: '2026-09-deposit50' }, signature: 'data:image/png;base64,iVBORw0KGgo=', terms_version: '2026-09-deposit50', terms_accepted: true, photos: { before: 3 }, scope: { keep_items: 'Blue bicycle', finish: ['shelving'], finish_details: { shelf_type: 'metal', shelf_qty: 2 } }, discovery: { success: 'Park a vehicle' }, logistics: { crew_size: 2, assigned_to: 'Crew of 2', notes: 'Use side gate' }, internal_notes: 'Keep blue bicycle.', notes: 'Call before arrival', client_checklists: { preJob: [], postJob: [] } });
function outcomeLedger() {
  const store = ledger({ 'customers/c1': { name: 'Synthetic Customer', phone: '9705550100', email: 'test@example.invalid', address: '100 Fixture Lane', highlevelContactId: 'contactA' },
    'jobs/w1': walkthrough('w1'), 'jobs/w2': walkthrough('w2', { time: '11:00', endTime: '12:00' }), 'jobs/w3': walkthrough('w3', { time: '13:00', endTime: '14:00' }), 'jobs/w4': walkthrough('w4', { time: '11:00', endTime: '12:00' }),
    'projects/project_w1': { customerId: 'c1', sourceWalkthroughId: 'w1', createdAt: '2026-09-20T15:00:00.000Z', highlevelContactId: 'contactA' }, 'projects/project_w4': { customerId: 'c1', sourceWalkthroughId: 'w4', createdAt: '2026-09-20T15:00:00.000Z' },
    'projects/project_w2': { customerId: 'c1', sourceWalkthroughId: 'w2', createdAt: '2026-09-20T15:00:00.000Z' } });
  const visit = id => store.rows.get(`jobs/${id}`);
  const act = (id, action, extra, now, session = rep) => recordWalkthroughVisit(store, session, { action, visitId: id, requestId: testUUID(), expectedRevision: visit(id).revision, ...extra }, now);
  const handoff = (id, now, acceptedAt, revise, jobDate) => saveWalkthroughHandoff(store, owner, { requestId: testUUID(), customerId: 'c1', sourceWalkthroughId: id, sourceRevision: visit(id).revision, plan: plan(acceptedAt, jobDate), ...(revise ? { jobId: revise, expectedRevision: store.rows.get(`jobs/${revise}`).revision } : {}) }, now);
  return { store, visit, act, handoff };
}

test('walkthrough outcomes join each Finish, No-show and sold handoff to its occurrence, with the reasons and start the follow-up needs', async () => {
  const { store, visit, act, handoff } = outcomeLedger();
  // w1: started and finished with a quote to follow.
  const start1 = await act('w1', 'start', { skipTimecard: true, recordingStatus: 'recorded' }, '2026-09-22T15:02:00.000Z');
  const finish1 = await act('w1', 'finish', { outcome: 'quote_to_follow', recordingStatus: 'recorded' }, '2026-09-22T15:50:00.000Z');
  // w2: a no-show, then Dispatch moves it and the rebooked occurrence ends not interested.
  const noShow = await act('w2', 'no_show', { reasonCode: 'customer_not_home' }, '2026-09-22T17:20:00.000Z');
  store.rows.set('jobs/w2', { ...visit('w2'), date: '2026-09-25', time: '10:00', endTime: '11:00', scheduleOccurrence: 2, revision: 'moved-r1' });
  await act('w2', 'start', { skipTimecard: true, recordingStatus: 'declined' }, '2026-09-25T16:05:00.000Z');
  const lost = await act('w2', 'finish', { outcome: 'not_interested', reasonCode: 'price', recordingStatus: 'declined' }, '2026-09-25T16:40:00.000Z');
  // w3: rescheduled; its reason lives only on the visit record.
  await act('w3', 'start', { skipTimecard: true, recordingStatus: 'recorded' }, '2026-09-25T19:01:00.000Z');
  const moved = await act('w3', 'finish', { outcome: 'rescheduled', reasonCode: 'customer_request', recordingStatus: 'failed_device' }, '2026-09-25T19:10:00.000Z');
  // w4: signed on site without a Start; a later revision's sale records no second outcome.
  const sold = await handoff('w4', '2026-09-25T20:00:00.000Z', '2026-09-25T19:55:00.000Z');
  await handoff('w4', '2026-09-25T20:30:00.000Z', '2026-09-25T20:25:00.000Z', sold.job.id);
  assert.equal(store.events('deal.sold').length, 2);
  // w1 also gets a handoff after its Finish: the sale is not an outcome (Finish already recorded one).
  await handoff('w1', '2026-09-25T21:00:00.000Z', '2026-09-25T20:58:00.000Z', null, '2026-09-29');

  const now = new Date(at('2026-09-25T21:00:00.000Z', SETTLED));
  const result = await walkthroughOutcomesFeed(store, walkthroughOutcomesInput({}), now);
  assert.equal(result.scanned, 7, 'every completed, no-show and sale event is scanned');
  assert.deepEqual([result.unverified, store.recordReads.at(-1)], [[], { collection: 'jobs', ids: ['w1', 'w2', 'w3', 'w4'], readTime: FIRESTORE_TIME }], 'visits are read once, at the page readTime');
  assert.deepEqual(result.outcomes.map(item => [item.visitId, item.outcome, item.reasonCode, item.recordingStatus, item.outcomeRevision, item.tookPlace, item.source, item.detail]), [
    ['w1', 'quote_to_follow', null, 'recorded', 1, true, 'walkthrough_visit', 'visit_record'],
    ['w2', 'customer_no_show', 'customer_not_home', null, 1, false, 'walkthrough_visit', 'visit_record'],
    ['w2', 'not_interested', 'price', 'declined', 2, true, 'walkthrough_visit', 'visit_record'],
    ['w3', 'rescheduled', 'customer_request', 'failed_device', 1, false, 'walkthrough_visit', 'visit_record'],
    ['w4', 'sold_on_site', null, null, 1, true, 'walkthrough_handoff', 'visit_record'],
  ]);
  const [quote, missed, rebooked, , signed] = result.outcomes;
  assert.deepEqual([quote.startedAt, quote.startedBy, quote.finishedAt, quote.performedBy, quote.clockSource, quote.projectId, quote.highlevelContactId], [start1.visit.walkthroughVisit.startedAt, 'sales.rep', finish1.visit.walkthroughOutcome.finishedAt, 'sales.rep', 'server', 'project_w1', 'contactA']);
  assert.deepEqual(quote.occurrence, { number: 1, date: '2026-09-22', time: '09:00', startAt: '2026-09-22T15:00:00.000Z' });
  assert.deepEqual([missed.startedAt, missed.finishedAt, missed.eventId], [null, noShow.visit.walkthroughOutcome.finishedAt, store.events('walkthrough.no_show')[0].id], 'the archived occurrence still resolves');
  assert.deepEqual([rebooked.occurrence.date, rebooked.startedAt, rebooked.finishedAt], ['2026-09-25', '2026-09-25T16:05:00.000Z', lost.visit.walkthroughOutcome.finishedAt]);
  assert.deepEqual([signed.finishedAt, signed.clockSource, signed.performedBy, signed.startedAt, signed.type], ['2026-09-25T19:55:00.000Z', 'device_validated', 'zacb', null, 'deal.sold']);
  assert.equal(moved.visit.walkthroughOutcome.reasonCode, 'customer_request');
  assert.deepEqual([result.hasMore, result.nextCursor, result.coverage.complete], [false, feedCursor(store.events().filter(event => WALKTHROUGH_OUTCOME_EVENT_TYPES.includes(event.type)).sort(byPosition('recordedAt')).at(-1)), true]);
  assert.equal(sold.job.id, store.events('deal.sold').sort(byPosition('recordedAt'))[0].jobId);
  // No money, signature or estimate leaves through the outcome feed.
  const text = JSON.stringify(result);
  for (const secret of ['140000', '1437', 'SYNTHETIC-SIGNATURE', 'amountCents', 'iVBOR']) assert.equal(text.includes(secret), false, secret);

  // Paging by one scanned event at a time delivers the same outcomes once each.
  const paged = []; let cursor = null;
  for (let page = 0; page < 20; page++) {
    const next = await walkthroughOutcomesFeed(store, walkthroughOutcomesInput({ sinceCursor: cursor, limit: 1 }), now);
    paged.push(...next.outcomes.map(item => item.eventId)); cursor = next.nextCursor;
    if (!next.hasMore) break;
  }
  assert.deepEqual(paged, result.outcomes.map(item => item.eventId));
  assert.deepEqual(store.queries.at(-1).types, [...WALKTHROUGH_OUTCOME_EVENT_TYPES]);
});

test('a Finish or No-show whose visit record is gone or disagrees is still delivered from its event; a handoff sale without its visit record is reported, never delivered', async () => {
  const { store, visit, act, handoff } = outcomeLedger();
  // w2: Started and Finished, then signed: the sale is not an outcome (its Finish is).
  await act('w2', 'start', { skipTimecard: true, recordingStatus: 'recorded' }, '2026-09-22T17:02:00.000Z');
  await act('w2', 'finish', { outcome: 'quote_to_follow', recordingStatus: 'recorded' }, '2026-09-22T17:40:00.000Z');
  await handoff('w2', '2026-09-22T17:50:00.000Z', '2026-09-22T17:45:00.000Z', null, '2026-09-29');
  // w4: signed on site (the sale sets sold_on_site), then a price revision (not an outcome).
  const sold = await handoff('w4', '2026-09-22T18:00:00.000Z', '2026-09-22T17:55:00.000Z');
  await handoff('w4', '2026-09-22T18:30:00.000Z', '2026-09-22T18:25:00.000Z', sold.job.id);
  await act('w3', 'start', { skipTimecard: true, recordingStatus: 'recorded' }, '2026-09-22T19:01:00.000Z');
  await act('w3', 'finish', { outcome: 'rescheduled', reasonCode: 'weather', recordingStatus: 'recorded' }, '2026-09-22T19:10:00.000Z');
  await act('w1', 'no_show', { reasonCode: 'no_access' }, '2026-09-22T19:20:00.000Z');
  const now = new Date(at('2026-09-22T19:20:00.000Z', SETTLED));
  const before = await walkthroughOutcomesFeed(store, walkthroughOutcomesInput({}), now);
  assert.deepEqual([before.outcomes.map(item => [item.visitId, item.outcome, item.detail]), before.unverified], [[['w2', 'quote_to_follow', 'visit_record'], ['w4', 'sold_on_site', 'visit_record'], ['w3', 'rescheduled', 'visit_record'], ['w1', 'customer_no_show', 'visit_record']], []]);
  // Business users can delete jobs docs through the legacy client SDK.
  for (const id of ['w2', 'w3', 'w4']) store.rows.delete(`jobs/${id}`);
  store.rows.set('jobs/w1', { ...visit('w1'), walkthroughOutcome: { ...visit('w1').walkthroughOutcome, outcome: 'quote_to_follow' } });
  const result = await walkthroughOutcomesFeed(store, walkthroughOutcomesInput({}), now);
  assert.deepEqual(result.outcomes.map(item => [item.visitId, item.outcome, item.reasonCode, item.startedAt, item.tookPlace, item.detail, item.detailReason, item.outcomeRevision]), [
    ['w2', 'quote_to_follow', null, null, true, 'event_only', 'visit_missing', null],
    ['w3', 'rescheduled', null, null, false, 'event_only', 'visit_missing', null],
    ['w1', 'customer_no_show', 'no_access', null, false, 'event_only', 'outcome_mismatch', 1],
  ], 'unknown stays null: the reschedule reason and start exist only on the visit record');
  // Without the visit, a sale cannot be told from a revision or a Started visit's sale: one sold_on_site outcome
  // per sale would collapse or misroute FUN-09's follow-ups, so every such sale is listed for review instead.
  const sales = store.events('deal.sold').sort(byPosition('recordedAt'));
  assert.deepEqual(result.unverified, sales.map(sale => ({ eventId: sale.id, cursor: feedCursor(sale), type: 'deal.sold', visitId: sale.walkthroughId, reason: 'visit_missing' })));
  assert.deepEqual([sales.map(sale => sale.walkthroughId), sales.map(sale => sale.data.estimateRevision), result.scanned], [['w2', 'w4', 'w4'], [1, 1, 2], 6]);
});

test('hub.funnel.case reads a project, a job (as its project) or a contact at one pinned snapshot, page by page', async () => {
  const { store, act, handoff } = outcomeLedger();
  await act('w1', 'start', { skipTimecard: true, recordingStatus: 'recorded' }, '2026-09-22T15:02:00.000Z');
  await act('w1', 'finish', { outcome: 'sold_on_site', recordingStatus: 'recorded' }, '2026-09-22T15:50:00.000Z');
  const sold = await handoff('w1', '2026-09-22T16:00:00.000Z', '2026-09-22T15:45:00.000Z');
  const projectEvents = store.events().filter(event => event.projectId === 'project_w1' || event.walkthroughId === 'w1').sort(byPosition('occurredAt'));
  assert.ok(projectEvents.length >= 4);
  const now = new Date('2026-09-22T19:05:00.000Z');
  const whole = await funnelCase(store, funnelCaseInput({ projectId: 'project_w1' }), now);
  assert.deepEqual(whole.events.map(event => event.id), projectEvents.map(event => event.id));
  assert.deepEqual(whole.case, { key: { field: 'projectId', value: 'project_w1' }, query: { field: 'projectId', value: 'project_w1' }, matches: [{ field: 'projectId', value: 'project_w1' }, { field: 'walkthroughId', value: 'w1' }],
    project: { id: 'project_w1', customerId: 'c1', highlevelContactId: 'contactA', sourceWalkthroughId: 'w1', sourceRecordId: null, previousProjectId: null, createdAt: '2026-09-20T15:00:00.000Z' } });
  assert.deepEqual([whole.nextCursor, whole.hasMore, whole.asOf, whole.coverage], [null, false, FIRESTORE_TIME, { complete: true, asOf: FIRESTORE_TIME, reasons: ['pre_cutover_history'] }]);
  assert.equal(JSON.stringify(whole).includes('SYNTHETIC-SIGNATURE'), false);
  // FUN-02 and FUN-05 receipts are stored under their requestId, so their ids never leave the Hub.
  assert.deepEqual([...new Set(whole.events.map(event => `${event.source.collection}:${event.source.id}`))].sort(), ['dispatchOperations:null', 'walkthroughHandoffs:null', 'walkthroughVisitOperations:null']);
  // A job id is its project's case; so is the walkthrough visit itself.
  for (const jobId of [sold.job.id, 'w1']) {
    const viaJob = await funnelCase(store, funnelCaseInput({ jobId }), now);
    assert.deepEqual([viaJob.case.key, viaJob.case.query, viaJob.events.map(event => event.id)], [{ field: 'jobId', value: jobId }, { field: 'projectId', value: 'project_w1' }, projectEvents.map(event => event.id)]);
  }
  const contact = await funnelCase(store, funnelCaseInput({ highlevelContactId: 'contactA' }), now);
  assert.deepEqual([contact.case.project, contact.case.matches, contact.events.map(event => event.id)], [null, [{ field: 'highlevelContactId', value: 'contactA' }], store.events().filter(event => event.highlevelContactId === 'contactA').sort(byPosition('occurredAt')).map(event => event.id)]);

  // Pages share the first page's readTime: an event committed meanwhile is not mixed in, and
  // the project is read as it was then.
  const first = await funnelCase(store, funnelCaseInput({ projectId: 'project_w1', limit: 2 }), now);
  assert.equal(first.hasMore, true); assert.match(first.nextCursor, HUB_FUNNEL_CASE_CURSOR_PATTERN);
  assert.deepEqual([store.recordReads.at(-1), store.queries.at(-1).readTime], [{ collection: 'projects', ids: ['project_w1'], readTime: null }, FIRESTORE_TIME], 'page one pins the readTime of its first read');
  store.clock = '2026-09-22T19:10:00.000001Z';
  await emit(store, '2026-09-22T19:09:00.000Z', jobEvent('job.completed', { id: sold.job.id, projectId: 'project_w1', highlevelContactId: 'contactA', type: 'job' }));
  await store.commit([{ collection: 'projects', id: 'project_w1', revision: store.rows.get('projects/project_w1').revision, patch: { highlevelContactId: 'contactB', updatedAt: '2026-09-22T19:10:00.000Z' } }]);
  const pages = [...first.events]; let cursor = first.nextCursor;
  while (cursor) {
    const page = await funnelCase(store, funnelCaseInput({ projectId: 'project_w1', cursor, limit: 2 }), now);
    assert.deepEqual([page.asOf, page.case.project.highlevelContactId, store.recordReads.at(-1).readTime], [FIRESTORE_TIME, 'contactA', FIRESTORE_TIME]);
    pages.push(...page.events); cursor = page.nextCursor;
  }
  assert.deepEqual(pages.map(event => event.id), projectEvents.map(event => event.id));
  const fresh = await funnelCase(store, funnelCaseInput({ projectId: 'project_w1' }), now);
  assert.deepEqual([fresh.events.length, fresh.case.project.highlevelContactId], [projectEvents.length + 1, 'contactB'], 'a new first page sees the new event and project');
  assert.equal(store.queries.at(-2).readTime, FIRESTORE_TIME);
  // A cursor continues only its own key, and only while Firestore can still read at its readTime.
  await rejectsCode(funnelCase(store, funnelCaseInput({ highlevelContactId: 'contactA', cursor: first.nextCursor }), now), 'hub_funnel_cursor_invalid', 400);
  await rejectsCode(funnelCase(store, funnelCaseInput({ projectId: 'project_w1', cursor: first.nextCursor }), new Date(Date.parse(FIRESTORE_TIME) + FUNNEL_CASE_CURSOR_MAX_AGE_MS + 1000)), 'hub_funnel_cursor_expired', 409);
});

test('a case cursor edited or forged to read another case, a later snapshot or another position is refused', async () => {
  const store = ledger({ 'jobs/job-a': job('job-a'), 'jobs/job-b': job('job-b', { projectId: 'project_b' }), 'projects/project_a': { customerId: 'c1', sourceRecordId: 'job-a' }, 'projects/project_b': { customerId: 'c1', sourceRecordId: 'job-b' } });
  await emit(store, T0, jobEvent('job.scheduled', job('job-a')), jobEvent('job.assigned', job('job-a')), jobEvent('job.scheduled', job('job-b', { projectId: 'project_b' })));
  const now = new Date('2026-09-22T19:05:00.000Z'), read = (key, cursor) => funnelCase(store, funnelCaseInput({ ...key, cursor, limit: 1 }), now);
  // The digest is not a secret: anyone can recompute it, as a forger would.
  const forge = (key, body) => `${body}~${createHash('sha256').update(`funnel-case|${Object.keys(key)[0]}=${Object.values(key)[0]}|${body}`).digest('hex').slice(0, 16)}`;
  const contactFirst = await read({ highlevelContactId: 'contactA' }), jobFirst = await read({ jobId: 'job-a' });
  const [, readTime, , , position] = /^c1~([^~]+)~([^~]+)~([^~]+)~([^~]+~fe_[0-9a-f]{40})~/.exec(contactFirst.nextCursor);
  const other = store.events().find(event => !position.endsWith(event.id));
  for (const [key, cursor] of [
    // The reviewer's probe: a contact's cursor redirected to another project's events.
    [{ highlevelContactId: 'contactA' }, forge({ highlevelContactId: 'contactA' }, `c1~${readTime}~projectId~project_b~${position}`)],
    // A job's cursor pointed at another project, or at the job's own id although it has a project.
    [{ jobId: 'job-a' }, forge({ jobId: 'job-a' }, `c1~${readTime}~projectId~project_b~${position}`)],
    [{ jobId: 'job-a' }, forge({ jobId: 'job-a' }, `c1~${readTime}~jobId~job-a~${position}`)],
    [{ projectId: 'project_a' }, forge({ projectId: 'project_a' }, `c1~${readTime}~walkthroughId~w1~${position}`)],
    // A snapshot more than the allowed clock skew after now, however well formed.
    [{ highlevelContactId: 'contactA' }, forge({ highlevelContactId: 'contactA' }, `c1~2026-09-22T19:06:00.001000Z~highlevelContactId~contactA~${position}`)],
    // An issued cursor with its readTime, query or position edited (digest not recomputed), or with the old key-only digest.
    [{ highlevelContactId: 'contactA' }, contactFirst.nextCursor.replace(readTime, '2026-09-22T18:59:00.000001Z')],
    [{ highlevelContactId: 'contactA' }, contactFirst.nextCursor.replace(position, `${other.occurredAt}~${other.id}`)],
    [{ jobId: 'job-a' }, jobFirst.nextCursor.replace('project_a', 'project_b')],
    [{ highlevelContactId: 'contactA' }, `${contactFirst.nextCursor.slice(0, contactFirst.nextCursor.lastIndexOf('~'))}~${createHash('sha256').update('funnel-case|highlevelContactId=contactA').digest('hex').slice(0, 16)}`],
    [{ jobId: 'job-b' }, jobFirst.nextCursor],
  ]) await rejectsCode(read(key, cursor), 'hub_funnel_cursor_invalid', 400);
  // What a cursor can still carry is harmless: the same case, at a snapshot and position its reader could ask for anyway.
  const same = await read({ jobId: 'job-a' }, forge({ jobId: 'job-a' }, `c1~${readTime}~projectId~project_a~2000-01-01T00:00:00.000Z~fe_${'0'.repeat(40)}`));
  assert.deepEqual([same.case.query, same.events.map(event => event.projectId)], [{ field: 'projectId', value: 'project_a' }, ['project_a']]);
  const issued = await read({ jobId: 'job-a' }, jobFirst.nextCursor);
  assert.deepEqual([issued.events.length, issued.hasMore, issued.asOf], [1, false, FIRESTORE_TIME]);
});

test('a case cursor whose readTime is a little ahead of the Hub clock (Firestore clock skew) continues; more than a minute ahead is refused', async () => {
  const store = ledger();
  // Firestore's clock runs 20 ms ahead of the Worker's, so page one's readTime is after the Hub's now.
  store.clock = '2026-09-22T19:00:00.020000Z';
  await emit(store, T0, jobEvent('job.scheduled', job('job-a')), jobEvent('job.assigned', job('job-a')));
  const now = Date.parse('2026-09-22T19:00:00.000Z'), issued = Date.parse(store.clock);
  const first = await funnelCase(store, funnelCaseInput({ highlevelContactId: 'contactA', limit: 1 }), new Date(now));
  assert.deepEqual([first.asOf, first.events.length, first.hasMore], [store.clock, 1, true]);
  const next = ms => funnelCase(store, funnelCaseInput({ highlevelContactId: 'contactA', cursor: first.nextCursor, limit: 1 }), new Date(ms));
  // Page two asked 5 ms later, while the readTime is still 15 ms ahead of the Hub clock.
  const second = await next(now + 5);
  assert.deepEqual([second.asOf, second.events.length, second.hasMore, second.nextCursor], [store.clock, 1, false, null]);
  assert.deepEqual([...first.events, ...second.events].map(event => event.id), store.events().sort(byPosition('occurredAt')).map(event => event.id));
  assert.equal(FUNNEL_CASE_CURSOR_SKEW_MS, 60000);
  assert.equal((await next(issued - FUNNEL_CASE_CURSOR_SKEW_MS)).events.length, 1, 'exactly a minute ahead is still skew');
  await rejectsCode(next(issued - FUNNEL_CASE_CURSOR_SKEW_MS - 1), 'hub_funnel_cursor_invalid', 400);
});

test('a project case includes its source walkthrough\'s and source job\'s events recorded before they were linked to it', async () => {
  const { store, act, handoff } = outcomeLedger();
  // A legacy walkthrough with no project: its Start and Finish events carry only its own id.
  const legacy = walkthrough('w5', { time: '15:00', endTime: '16:00' }); delete legacy.projectId;
  store.rows.set('jobs/w5', { ...legacy, id: 'w5', revision: 'w5-r0' });
  await act('w5', 'start', { skipTimecard: true, recordingStatus: 'recorded' }, '2026-09-22T21:02:00.000Z');
  await act('w5', 'finish', { outcome: 'quote_to_follow', recordingStatus: 'recorded' }, '2026-09-22T21:40:00.000Z');
  const unlinked = store.events().filter(event => event.walkthroughId === 'w5');
  assert.ok(unlinked.length >= 2 && unlinked.every(event => event.projectId === null), 'the walkthrough events predate any project');
  // The signed handoff creates project_w5 from the walkthrough and back-fills its projectId (dispatch-service).
  const sold = await handoff('w5', '2026-09-22T22:00:00.000Z', '2026-09-22T21:55:00.000Z', null, '2026-09-30');
  assert.deepEqual([sold.job.projectId, store.rows.get('jobs/w5').projectId, store.rows.get('projects/project_w5').sourceWalkthroughId], ['project_w5', 'project_w5', 'w5']);
  const expected = store.events().filter(event => event.projectId === 'project_w5' || event.walkthroughId === 'w5').sort(byPosition('occurredAt')).map(event => event.id);
  const now = new Date('2026-09-22T19:05:00.000Z');
  for (const key of [{ projectId: 'project_w5' }, { jobId: 'w5' }, { jobId: sold.job.id }]) {
    const found = await funnelCase(store, funnelCaseInput(key), now);
    assert.deepEqual(found.events.map(event => event.id), expected, JSON.stringify(key));
    for (const event of unlinked) assert.ok(found.events.some(item => item.id === event.id));
  }
  // Paged one event at a time, the combined case keeps one order and loses nothing.
  const paged = []; let cursor = null;
  do { const page = await funnelCase(store, funnelCaseInput({ projectId: 'project_w5', cursor: cursor ?? undefined, limit: 1 }), now); paged.push(...page.events.map(event => event.id)); cursor = page.nextCursor; } while (cursor);
  assert.deepEqual(paged, expected);
  // A project a rework visit made from a legacy job reads that job's pre-link events by its id.
  store.rows.set('jobs/legacy-job', { ...job('legacy-job', { projectId: 'project_r' }), revision: 'legacy-r1' });
  store.rows.set('projects/project_r', { id: 'project_r', customerId: 'c1', sourceRecordId: 'legacy-job', sourceWalkthroughId: null, createdAt: '2026-09-22T12:00:00.000Z', revision: 'project-r-r1' });
  const [early] = await emit(store, T0, jobEvent('job.scheduled', job('legacy-job', { projectId: undefined })));
  const [late] = await emit(store, at(T0, MIN), jobEvent('job.assigned', job('rework-job', { projectId: 'project_r' })));
  const rework = await funnelCase(store, funnelCaseInput({ projectId: 'project_r' }), now);
  assert.deepEqual([rework.case.matches, rework.events.map(event => event.id)], [[{ field: 'projectId', value: 'project_r' }, { field: 'jobId', value: 'legacy-job' }], [early.id, late.id]]);
  assert.deepEqual(store.queries.at(-1).anyOf, rework.case.matches);
  // A rework booked from a legacy job made from a legacy walkthrough, neither with a project: dispatch-service makes
  // project_<walkthrough> with the job as its source and no sourceWalkthroughId, and back-fills only the job. The
  // walkthrough's events are matched through the jobs' sourceWalkthroughId, read at the case's readTime.
  const oldWalk = walkthrough('w6', { time: '07:00', endTime: '08:00' }); delete oldWalk.projectId;
  store.rows.set('jobs/w6', { ...oldWalk, id: 'w6', revision: 'w6-r0' });
  await act('w6', 'start', { skipTimecard: true, recordingStatus: 'recorded' }, '2026-09-22T13:02:00.000Z');
  await act('w6', 'finish', { outcome: 'quote_to_follow', recordingStatus: 'recorded' }, '2026-09-22T13:40:00.000Z');
  const oldJob = job('j-old', { status: 'completed', sourceWalkthroughId: 'w6' }); delete oldJob.projectId;
  store.rows.set('jobs/j-old', { ...oldJob, revision: 'j-old-r1' });
  await emit(store, '2026-09-22T14:00:00.000Z', jobEvent('job.scheduled', oldJob));
  const walkEvents = store.events().filter(event => event.walkthroughId === 'w6');
  assert.ok(walkEvents.length >= 2 && walkEvents.every(event => event.projectId === null && event.jobId === null), 'the walkthrough events carry only its own id');
  const lone = await funnelCase(store, funnelCaseInput({ jobId: 'j-old' }), now);
  assert.deepEqual([lone.case.query, lone.case.matches], [{ field: 'jobId', value: 'j-old' }, [{ field: 'jobId', value: 'j-old' }, { field: 'walkthroughId', value: 'w6' }]], 'before any project, the job\'s case reads the walkthrough it came from');
  const booked = await mutateDispatch(store, owner, { action: 'schedule.create', requestId: testUUID(), customerId: 'c1', kind: 'job', sourceJobId: 'j-old', changes: { date: '2026-09-29', time: '08:00', endTime: '10:00', assignedCrew: ['crew1'] }, booking: { visitPurpose: 'rework', reworkOfJobId: 'j-old' } }, '2026-09-22T18:30:00.000Z');
  const legacyProject = store.rows.get('projects/project_w6');
  assert.deepEqual([store.rows.get(`jobs/${booked.job.id}`).projectId, store.rows.get('jobs/j-old').projectId, store.rows.get('jobs/w6').projectId, legacyProject.sourceRecordId, legacyProject.sourceWalkthroughId], ['project_w6', 'project_w6', undefined, 'j-old', null]);
  const legacyCase = store.events().filter(event => event.projectId === 'project_w6' || event.jobId === 'j-old' || event.walkthroughId === 'w6').sort(byPosition('occurredAt')).map(event => event.id);
  for (const key of [{ jobId: booked.job.id }, { jobId: 'j-old' }, { projectId: 'project_w6' }]) {
    const found = await funnelCase(store, funnelCaseInput(key), now);
    assert.deepEqual([found.events.map(event => event.id), found.coverage.complete], [legacyCase, true], JSON.stringify(key));
    for (const event of walkEvents) assert.ok(found.events.some(item => item.id === event.id), JSON.stringify(key));
  }
  assert.deepEqual(store.recordReads.slice(-2), [{ collection: 'projects', ids: ['project_w6'], readTime: null }, { collection: 'jobs', ids: ['j-old'], readTime: FIRESTORE_TIME }], 'the source job is read at the project\'s readTime');
  assert.deepEqual(store.queries.at(-1).anyOf, [{ field: 'projectId', value: 'project_w6' }, { field: 'jobId', value: 'j-old' }, { field: 'walkthroughId', value: 'w6' }]);
  const legacyPaged = []; cursor = null;
  do { const page = await funnelCase(store, funnelCaseInput({ projectId: 'project_w6', cursor: cursor ?? undefined, limit: 1 }), now); legacyPaged.push(...page.events.map(event => event.id)); cursor = page.nextCursor; } while (cursor);
  assert.deepEqual([legacyPaged, store.recordReads.at(-1)], [legacyCase, { collection: 'jobs', ids: ['j-old'], readTime: FIRESTORE_TIME }]);
});

test('hub.funnel.case reads a job or walkthrough without a project by its own id and refuses unknown or private records', async () => {
  const store = ledger({ 'jobs/legacy-job': { type: 'job', status: 'scheduled' }, 'jobs/legacy-walk': { type: 'walkthrough', status: 'scheduled' }, 'jobs/secret': { recordType: 'employee_hub_v2' } });
  await emit(store, T0, jobEvent('job.scheduled', { id: 'legacy-job', type: 'job' }));
  await emit(store, T0, { type: 'walkthrough.booked', idempotencyKey: { kind: 'requestId', value: testUUID() }, walkthroughId: 'legacy-walk', actor: { id: 'zacb', kind: 'human', role: 'owner' }, via: 'hub', source: { collection: 'dispatchOperations', id: testUUID() }, eligibility: { hub: { id: 'legacy-walk', type: 'walkthrough' } } });
  const now = new Date(at(T0, MIN));
  const legacyJob = await funnelCase(store, funnelCaseInput({ jobId: 'legacy-job' }), now), legacyWalk = await funnelCase(store, funnelCaseInput({ jobId: 'legacy-walk' }), now);
  assert.deepEqual([legacyJob.case.query, legacyJob.events.map(event => event.type)], [{ field: 'jobId', value: 'legacy-job' }, ['job.scheduled']]);
  assert.deepEqual([legacyWalk.case.query, legacyWalk.events.map(event => event.type)], [{ field: 'walkthroughId', value: 'legacy-walk' }, ['walkthrough.booked']]);
  await rejectsCode(funnelCase(store, funnelCaseInput({ jobId: 'missing' }), now), 'hub_funnel_case_not_found', 404);
  await rejectsCode(funnelCase(store, funnelCaseInput({ jobId: 'secret' }), now), 'hub_funnel_case_not_found', 404);
  await rejectsCode(funnelCase(store, funnelCaseInput({ projectId: 'project_missing' }), now), 'hub_funnel_case_not_found', 404);
  const contact = await funnelCase(store, funnelCaseInput({ highlevelContactId: 'nobody' }), now);
  assert.deepEqual([contact.events, contact.hasMore, contact.coverage.complete], [[], false, true], 'a contact with no Hub events is an empty, complete case');
});

// The Firestore REST adapter: one ordered, resumable structured query per page and masked reads.
function rest(t, respond) {
  const calls = [];
  const fetcher = async (env, url, init = {}) => { const body = init.body ? JSON.parse(init.body) : null; calls.push({ env, url: String(url), method: init.method || 'GET', body }); return respond(String(url), body); };
  return { storage: funnelFeedStorage({ synthetic: true }, fetcher), calls };
}
const ROOT = 'projects/egcw-1ec83/databases/(default)/documents', BASE = `https://firestore.googleapis.com/v1/${ROOT}`;
const doc = (collection, id, fields) => ({ name: `${ROOT}/${collection}/${id}`, updateTime: '2026-09-22T18:00:00.000000Z', fields: encodeFirestoreFields(fields) });

test('the Firestore feed storage sends one ordered keyset query with the filters, horizon and pinned readTime', async t => {
  const id = `fe_${'a'.repeat(40)}`, after = { at: T0, id: `fe_${'b'.repeat(40)}` };
  const { storage, calls } = rest(t, () => Response.json([{ document: doc('funnelEvents', id, { type: 'deal.sold', recordedAt: T0, data: { amountCents: 5 } }), readTime: FIRESTORE_TIME }]));
  const page = await storage.funnelEventsPage({ order: 'recordedAt', types: ['deal.sold', 'job.scheduled'], anyOf: null, through: T0, after, limit: 3, readTime: null });
  assert.deepEqual(page, { rows: [{ type: 'deal.sold', recordedAt: T0, data: { amountCents: 5 }, id, revision: '2026-09-22T18:00:00.000000Z' }], readTime: FIRESTORE_TIME });
  assert.deepEqual(calls[0], { env: { synthetic: true }, url: `${BASE}:runQuery`, method: 'POST', body: { structuredQuery: {
    from: [{ collectionId: 'funnelEvents' }],
    where: { compositeFilter: { op: 'AND', filters: [{ fieldFilter: { field: { fieldPath: 'type' }, op: 'IN', value: { arrayValue: { values: [{ stringValue: 'deal.sold' }, { stringValue: 'job.scheduled' }] } } } }, { fieldFilter: { field: { fieldPath: 'recordedAt' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: T0 } } }] } },
    orderBy: [{ field: { fieldPath: 'recordedAt' }, direction: 'ASCENDING' }, { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
    startAt: { values: [{ stringValue: T0 }, { referenceValue: `${ROOT}/funnelEvents/${after.id}` }], before: false }, limit: 3 } } });
  await storage.funnelEventsPage({ order: 'occurredAt', types: null, anyOf: [{ field: 'projectId', value: 'project_a' }], through: null, after: null, limit: 2, readTime: FIRESTORE_TIME });
  assert.deepEqual(calls[1].body, { structuredQuery: { from: [{ collectionId: 'funnelEvents' }], where: { fieldFilter: { field: { fieldPath: 'projectId' }, op: 'EQUAL', value: { stringValue: 'project_a' } } },
    orderBy: [{ field: { fieldPath: 'occurredAt' }, direction: 'ASCENDING' }, { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }], limit: 2 }, readTime: FIRESTORE_TIME });
  // A case matching several ids is one OR query, resumed after the cursor like any other.
  await storage.funnelEventsPage({ order: 'occurredAt', types: null, anyOf: [{ field: 'projectId', value: 'project_a' }, { field: 'walkthroughId', value: 'w1' }, { field: 'jobId', value: 'job-a' }], through: null, after, limit: 2, readTime: FIRESTORE_TIME });
  assert.deepEqual(calls[2].body, { structuredQuery: { from: [{ collectionId: 'funnelEvents' }],
    where: { compositeFilter: { op: 'OR', filters: [['projectId', 'project_a'], ['walkthroughId', 'w1'], ['jobId', 'job-a']].map(([fieldPath, stringValue]) => ({ fieldFilter: { field: { fieldPath }, op: 'EQUAL', value: { stringValue } } })) } },
    orderBy: [{ field: { fieldPath: 'occurredAt' }, direction: 'ASCENDING' }, { field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
    startAt: { values: [{ stringValue: T0 }, { referenceValue: `${ROOT}/funnelEvents/${after.id}` }], before: false }, limit: 2 }, readTime: FIRESTORE_TIME });
  await storage.funnelEventsPage({ order: 'recordedAt', types: ['deal.sold'], anyOf: null, through: null, after: null, limit: 1, readTime: null });
  assert.deepEqual(calls[3].body.structuredQuery.where, { fieldFilter: { field: { fieldPath: 'type' }, op: 'EQUAL', value: { stringValue: 'deal.sold' } } });
  const empty = rest(t, () => Response.json([{ readTime: FIRESTORE_TIME }]));
  assert.deepEqual(await empty.storage.funnelEventsPage({ order: 'recordedAt', types: null, anyOf: null, through: T0, after: null, limit: 1, readTime: null }), { rows: [], readTime: FIRESTORE_TIME });
});

test('the Firestore feed storage reads records through a field mask at one readTime and fails closed on anything unverifiable', async t => {
  const { storage, calls } = rest(t, (url, body) => Response.json(body.documents.map(name => name.endsWith('/w1') ? { found: doc('jobs', 'w1', { type: 'walkthrough', walkthroughOutcome: { outcome: 'quote_to_follow' } }), readTime: body.readTime || FIRESTORE_TIME } : { missing: name, readTime: body.readTime || FIRESTORE_TIME })));
  assert.deepEqual(await storage.funnelRecords('jobs', ['w1', 'w2'], ['type', 'walkthroughOutcome']), { rows: [{ type: 'walkthrough', walkthroughOutcome: { outcome: 'quote_to_follow' }, id: 'w1', revision: '2026-09-22T18:00:00.000000Z' }], readTime: FIRESTORE_TIME });
  assert.deepEqual(calls[0], { env: { synthetic: true }, url: `${BASE}:batchGet`, method: 'POST', body: { documents: [`${ROOT}/jobs/w1`, `${ROOT}/jobs/w2`], mask: { fieldPaths: ['type', 'walkthroughOutcome'] } } });
  const pinned = '2026-09-22T18:30:00.000001Z';
  assert.deepEqual(await storage.funnelRecords('projects', ['project_missing'], ['customerId'], pinned), { rows: [], readTime: pinned });
  assert.deepEqual(calls[1].body, { documents: [`${ROOT}/projects/project_missing`], mask: { fieldPaths: ['customerId'] }, readTime: pinned });
  assert.deepEqual(await storage.funnelRecords('jobs', [], ['type'], pinned), { rows: [], readTime: pinned });
  assert.equal(calls.length, 2);
  for (const [response, code] of [[() => new Response('{}', { status: 503 }), 'hub_funnel_storage_unavailable'], [() => { throw new Error('network'); }, 'hub_funnel_storage_unavailable'], [() => new Response('not json'), 'hub_funnel_storage_incomplete'],
    [() => Response.json([]), 'hub_funnel_storage_incomplete'], [() => Response.json({ documents: [] }), 'hub_funnel_storage_incomplete'], [() => Response.json([{ readTime: FIRESTORE_TIME }, { readTime: '2026-09-22T19:00:01.000001Z' }]), 'hub_funnel_storage_incomplete'],
    [() => Response.json([{ document: { name: `${ROOT}/jobs/x`, updateTime: 'r' }, readTime: FIRESTORE_TIME }]), 'hub_funnel_storage_incomplete'], [() => Response.json([{ document: { name: `${ROOT}/funnelEvents/x` }, readTime: FIRESTORE_TIME }]), 'hub_funnel_storage_incomplete']]) {
    const failing = rest(t, response);
    await rejectsCode(failing.storage.funnelEventsPage({ order: 'recordedAt', types: null, anyOf: null, through: T0, after: null, limit: 1, readTime: null }), code, 503);
  }
  for (const response of [[{ unexpected: true }], [{ missing: `${ROOT}/jobs/w1`, readTime: FIRESTORE_TIME }, { missing: `${ROOT}/jobs/w2`, readTime: FIRESTORE_TIME }], [{ missing: `${ROOT}/jobs/w1` }],
    [{ found: doc('projects', 'w1', {}), readTime: FIRESTORE_TIME }], [{ found: { name: `${ROOT}/jobs/w1` }, readTime: FIRESTORE_TIME }]])
    await rejectsCode(rest(t, () => Response.json(response)).storage.funnelRecords('jobs', ['w1'], ['type']), 'hub_funnel_storage_incomplete', 503);
  // The feed checks what the storage returns: only the asked ids, each once, at the pinned time.
  const faulty = records => ({ funnelRecords: async (collection, ids, fields, readTime) => records(ids, readTime) });
  for (const records of [() => ({ rows: [{ id: 'other', type: 'job' }], readTime: FIRESTORE_TIME }), ids => ({ rows: [{ id: ids[0], type: 'job' }, { id: ids[0], type: 'job' }], readTime: FIRESTORE_TIME }),
    () => ({ rows: [{ id: 'job-a', type: 'job' }] }), () => ({ rows: [{ id: 'job-a', type: 'job' }], readTime: 'now' }), () => [{ id: 'job-a', type: 'job' }]])
    await rejectsCode(funnelCase(faulty(records), funnelCaseInput({ jobId: 'job-a' }), new Date(NOW)), 'hub_funnel_storage_incomplete', 503);
  const { store, act } = outcomeLedger();
  await act('w1', 'no_show', { reasonCode: 'no_access' }, '2026-09-22T19:20:00.000Z');
  const drifted = { ...store, funnelRecords: async (collection, ids) => ({ rows: ids.map(id => ({ id, type: 'walkthrough' })), readTime: '2026-09-22T18:59:00.000001Z' }) };
  await rejectsCode(walkthroughOutcomesFeed(drifted, walkthroughOutcomesInput({}), new Date(at('2026-09-22T19:20:00.000Z', SETTLED))), 'hub_funnel_storage_incomplete', 503);
});

// End to end through the signed bridge endpoint with Firestore mocked at the fetch layer.
const NOW = '2026-09-22T19:00:00.000Z', key = 'isolated-funnel-feed-test-key-0123456789abcdef';
const staffEnv = extra => ({ EGC_OPERATIONS_ENABLED: 'true', EGC_OPERATIONS_PORTAL_SIGNING_SECRET: key, FIREBASE_API_KEY: 'firebase-test-funnel-feed',
  HUB_AUTH_USERS_JSON: JSON.stringify({ zacb: { passwordHash: 'synthetic-hash-never-returned', role: 'owner', displayName: 'Synthetic Owner' }, tylerg: { passwordHash: 'synthetic-hash-never-returned', role: 'manager', displayName: 'Synthetic Manager' }, alexk: { passwordHash: 'synthetic-hash-never-returned', role: 'sales', displayName: 'Synthetic Sales' } }), ...extra });
async function signed(actor, body, env = staffEnv()) {
  const claims = { v: 1, iss: 'portal', aud: 'egc-portal', iat: Math.floor(Date.parse(NOW) / 1000), nonce: testUUID(), actor, request: { requestId: testUUID(), body } };
  const response = await portal({ request: new Request('https://portal.test/api/operations-portal', { method: 'POST', body: JSON.stringify({ envelope: await signOperationsEnvelope(claims, key) }) }), env });
  return { status: response.status, body: await response.json() };
}

test('the signed bridge serves hub.funnel.events from Firestore to owners, managers and verified delegates only', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  const a = job('job-a'), [event] = [await funnelEventWrite(null, '2026-09-22T18:00:00.000Z', jobEvent('deal.sold', a, { amountCents: 140000, estimateRevision: 1 }))];
  const queries = [];
  const fetched = t.mock.method(globalThis, 'fetch', async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.hostname, 'firestore.googleapis.com'); assert.equal(url.searchParams.get('key'), 'firebase-test-funnel-feed');
    assert.ok(url.pathname.endsWith(':runQuery'), url.pathname);
    queries.push(JSON.parse(init.body));
    return Response.json([{ document: { name: `${ROOT}/funnelEvents/${event.id}`, updateTime: '2026-09-22T18:00:00.100000Z', fields: encodeFirestoreFields({ ...event.patch, hourlyRate: 42 }) }, readTime: FIRESTORE_TIME }]);
  });
  const owners = await signed({ id: 'zacb', role: 'owner', kind: 'human', workspace: 'egc' }, { command: 'hub.funnel.events', types: ['deal.sold'] });
  assert.equal(owners.status, 200);
  assert.deepEqual([owners.body.ok, owners.body.authority, owners.body.command, owners.body.actedAs], [true, 'employee_hub', 'hub.funnel.events', { user: 'zacb', delegatedBy: null }]);
  assert.deepEqual(owners.body.events.map(row => [row.id, row.type, row.data, row.cursor]), [[event.id, 'deal.sold', { amountCents: 140000, estimateRevision: 1 }, `f1~${event.patch.recordedAt}~${event.id}`]]);
  assert.deepEqual([owners.body.nextCursor, owners.body.settledThrough, owners.body.asOf], [`f1~${event.patch.recordedAt}~${event.id}`, at(NOW, -SETTLED), FIRESTORE_TIME]);
  assert.equal(JSON.stringify(owners.body).includes('hourlyRate'), false);
  assert.deepEqual(queries[0].structuredQuery.where.compositeFilter.filters.map(filter => [filter.fieldFilter.field.fieldPath, filter.fieldFilter.op]), [['type', 'EQUAL'], ['recordedAt', 'LESS_THAN_OR_EQUAL']]);
  const manager = await signed({ id: 'tylerg', role: 'manager', kind: 'human', workspace: 'egc' }, { command: 'hub.walkthrough.outcomes' });
  assert.deepEqual([manager.status, manager.body.outcomes, manager.body.scanned], [200, [], 1], 'a sale that is not a handoff outcome is scanned, never delivered as one');
  const grant = { id: 'walkthrough-followup-worker', role: 'integration', kind: 'integration', workspace: 'egc' };
  assert.deepEqual(await signed({ id: 'alexk', role: 'sales', kind: 'human', workspace: 'egc' }, { command: 'hub.funnel.events' }), { status: 403, body: { error: 'hub_role_forbidden' } });
  assert.deepEqual(await signed(grant, { command: 'hub.funnel.events' }), { status: 403, body: { error: 'hub_delegate_required' } });
  assert.deepEqual(await signed(grant, { command: 'hub.funnel.events', delegate: 'zacb' }), { status: 403, body: { error: 'hub_delegate_unverified' } });
  assert.deepEqual(await signed(grant, { command: 'hub.funnel.events', delegate: 'alexk' }, staffEnv({ EGC_OPERATIONS_HUB_DELEGATES_JSON: JSON.stringify({ [grant.id]: 'alexk' }) })), { status: 403, body: { error: 'hub_role_forbidden' } }, 'a delegate acts with its user\'s current role');
  const delegated = await signed(grant, { command: 'hub.funnel.events', delegate: 'zacb' }, staffEnv({ EGC_OPERATIONS_HUB_DELEGATES_JSON: JSON.stringify({ [grant.id]: 'zacb' }) }));
  assert.deepEqual([delegated.status, delegated.body.actedAs, delegated.body.events.length], [200, { user: 'zacb', delegatedBy: grant.id }, 1]);
  assert.deepEqual(await signed({ id: 'zacb', role: 'owner', kind: 'human', workspace: 'egc' }, { command: 'hub.funnel.events', sinceCursor: 'f1~nope' }), { status: 400, body: { error: 'hub_funnel_cursor_invalid' } });
  assert.deepEqual(await signed({ id: 'zacb', role: 'owner', kind: 'human', workspace: 'egc' }, { command: 'hub.funnel.case', projectId: 'project_a', jobId: 'job-a' }), { status: 400, body: { error: 'hub_command_invalid' } });
  assert.deepEqual(await signed({ id: 'zacb', role: 'owner', kind: 'human', workspace: 'egc' }, { command: 'hub.funnel.events', requestId: testUUID() }), { status: 400, body: { error: 'hub_command_invalid' } });
  // Each command refuses crew roles, a human or delegate whose Hub role changed or was revoked since signing,
  // a delegate mapped to someone else and an MCP principal with no map entry, before any storage read.
  const STAFF = { zacb: 'owner', tylerg: 'manager', alexk: 'sales', crew1: 'crew', lead1: 'crew_lead' };
  const staff = (roles, extra = {}) => staffEnv({ HUB_AUTH_USERS_JSON: JSON.stringify(Object.fromEntries(Object.entries(roles).map(([user, role]) => [user, { passwordHash: 'synthetic-hash-never-returned', role, displayName: `Synthetic ${role}` }]))), ...extra });
  const mapped = user => ({ EGC_OPERATIONS_HUB_DELEGATES_JSON: JSON.stringify({ [grant.id]: user }) });
  const human = (id, role) => ({ id, role, kind: 'human', workspace: 'egc' });
  const refusals = [
    ['a crew human', human('crew1', 'crew'), {}, staff(STAFF), 401, 'unauthorized'],
    ['a crew_lead human', human('lead1', 'crew_lead'), {}, staff(STAFF), 401, 'unauthorized'],
    ['a manager demoted to sales since the token', human('tylerg', 'manager'), {}, staff({ ...STAFF, tylerg: 'sales' }), 403, 'hub_actor_changed'],
    ['a manager demoted to crew since the token', human('tylerg', 'manager'), {}, staff({ ...STAFF, tylerg: 'crew' }), 403, 'hub_actor_role_forbidden'],
    ['a manager revoked since the token', human('tylerg', 'manager'), {}, staff({ zacb: 'owner' }), 403, 'hub_actor_unknown'],
    ['a delegate demoted to sales', grant, { delegate: 'tylerg' }, staff({ ...STAFF, tylerg: 'sales' }, mapped('tylerg')), 403, 'hub_role_forbidden'],
    ['a delegate demoted to crew', grant, { delegate: 'tylerg' }, staff({ ...STAFF, tylerg: 'crew' }, mapped('tylerg')), 403, 'hub_actor_role_forbidden'],
    ['a revoked delegate', grant, { delegate: 'tylerg' }, staff({ zacb: 'owner' }, mapped('tylerg')), 403, 'hub_delegate_unverified'],
    ['a delegate mapped to another user', grant, { delegate: 'zacb' }, staff(STAFF, mapped('tylerg')), 403, 'hub_delegate_unverified'],
    ['an MCP service principal with no map entry', { ...grant, id: 'mcp-service-grant' }, { delegate: 'zacb' }, staff(STAFF, mapped('zacb')), 403, 'hub_delegate_unverified'],
    ['an MCP OAuth principal with no map entry', { ...grant, id: 'mcp-oauth-grant:6ba7b810-9dad-41d1-80b4-00c04fd430c8' }, { delegate: 'zacb' }, staff(STAFF), 403, 'hub_delegate_unverified'],
  ];
  const reads = fetched.mock.callCount();
  for (const command of ['hub.funnel.events', 'hub.walkthrough.outcomes', 'hub.funnel.case']) for (const [who, actor, extra, env, status, error] of refusals)
    assert.deepEqual(await signed(actor, { command, ...(command === 'hub.funnel.case' ? { jobId: 'job-a' } : {}), ...extra }, env), { status, body: { error } }, `${command}: ${who}`);
  assert.equal(fetched.mock.callCount(), reads, 'no refusal reads storage');
});

test('the signed bridge fails closed when the ledger cannot be read', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(NOW) });
  t.mock.method(globalThis, 'fetch', async () => new Response('{"error":{"message":"The query requires an index. You can create it here: https://console.firebase.google.com/private"}}', { status: 400 }));
  assert.deepEqual(await signed({ id: 'zacb', role: 'owner', kind: 'human', workspace: 'egc' }, { command: 'hub.funnel.events', types: ['deal.sold', 'job.scheduled'] }), { status: 503, body: { error: 'hub_funnel_storage_unavailable' } });
  assert.deepEqual(await signed({ id: 'zacb', role: 'owner', kind: 'human', workspace: 'egc' }, { command: 'hub.funnel.case', highlevelContactId: 'contactA' }), { status: 503, body: { error: 'hub_funnel_storage_unavailable' } });
});

test('runHubCommand routes each funnel command to its handler with the injected store and clock', async () => {
  const store = ledger(), a = job('job-a');
  await emit(store, T0, jobEvent('job.scheduled', a));
  const profiles = [{ user: 'zacb', displayName: 'Synthetic Owner', role: 'owner', businessAccess: true }, { user: 'tylerg', displayName: 'Synthetic Manager', role: 'manager', businessAccess: true }];
  const options = { storage: () => store, profiles: () => profiles, delegates: () => new Map(), now: () => new Date(at(T0, SETTLED)) };
  const manager = { id: 'tylerg', role: 'manager', kind: 'human', workspace: 'egc' };
  const events = await runHubCommand({}, manager, { command: 'hub.funnel.events', limit: 5 }, options);
  assert.deepEqual([events.ok, events.command, events.events.length, events.settledThrough], [true, 'hub.funnel.events', 1, T0]);
  const outcomes = await runHubCommand({}, manager, { command: 'hub.walkthrough.outcomes' }, options);
  assert.deepEqual([outcomes.outcomes, outcomes.scanned], [[], 0]);
  const theCase = await runHubCommand({}, manager, { command: 'hub.funnel.case', jobId: 'job-a' }, { ...options, storage: () => ({ ...store, funnelRecords: async (collection, ids, fields, readTime) => ({ rows: collection === 'jobs' ? [{ id: ids[0], type: 'job' }] : [], readTime: readTime || FIRESTORE_TIME }) }) });
  assert.deepEqual([theCase.case.query, theCase.events.length], [{ field: 'jobId', value: 'job-a' }, 1]);
  await rejectsCode(runHubCommand({}, manager, { command: 'hub.funnel.events', confirmed: true }, options), 'hub_command_invalid', 400);
});
