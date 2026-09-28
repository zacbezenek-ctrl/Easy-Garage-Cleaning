import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const enabled = process.env.EGC_FIREBASE_EMULATOR_TEST === '1';

// FUN-37 on real Firestore: the feed's keyset pages, the case read's OR query over the
// project and its source records, and pinned readTime reads (runQuery and batchGet).
test('the funnel feed REST contracts hold on real Firestore', { skip: !enabled, timeout: 180000 }, async t => {
  const host = process.env.FIRESTORE_EMULATOR_HOST || '';
  assert.match(host, /^(?:127\.0\.0\.1|localhost):\d{2,5}$/, 'This test may only connect to a loopback Firestore emulator.');
  const projectId = /^demo-[a-z0-9-]+$/.test(process.env.GCLOUD_PROJECT || '') ? process.env.GCLOUD_PROJECT : 'demo-egc-field-rules';
  const [hostname] = host.split(':');
  const { dispatchStorage } = await import('../functions/_lib/dispatch-storage.js');
  const { funnelEventWrite } = await import('../functions/_lib/funnel-events.js');
  const { funnelCase, funnelCaseInput, funnelEventsFeed, funnelEventsInput, funnelFeedStorage } = await import('../functions/_lib/funnel-feed.js');
  const fetcher = async (_env, url, options = {}) => {
    const target = new URL(url); target.protocol = 'http:'; target.host = host; target.pathname = target.pathname.replace('/projects/egcw-1ec83/', `/projects/${projectId}/`);
    assert.equal(target.hostname, hostname);
    return fetch(target, { ...options, ...(options.body ? { body: options.body.replaceAll('projects/egcw-1ec83/', `projects/${projectId}/`) } : {}), headers: { ...options.headers, Authorization: 'Bearer owner' } });
  };
  const store = { ...dispatchStorage({}, fetcher), ...funnelFeedStorage({}, fetcher) };
  // Unique records and a run-specific recordedAt window, so reruns and other suites on the same emulator never mix in.
  const run = randomUUID().replaceAll('-', '').slice(0, 10), base = Date.parse('2031-01-01T00:00:00.000Z') + parseInt(run.slice(0, 6), 16) % 3650 * 86400000;
  const at = minutes => new Date(base + minutes * 60000).toISOString();
  const P = `project_fe${run}`, W = `walk_fe${run}`, J = `job_fe${run}`, OTHER = `project_other${run}`, contact = `contactFe${run}`;
  const actor = { id: 'zacb', kind: 'human', role: 'owner' }, source = () => ({ collection: 'dispatchOperations', id: randomUUID() });
  const booked = clock => funnelEventWrite(null, clock, { type: 'walkthrough.booked', idempotencyKey: { kind: 'requestId', value: randomUUID() }, walkthroughId: W, highlevelContactId: contact, actor, via: 'hub', source: source(), eligibility: { hub: { id: W, type: 'walkthrough' } } });
  const jobEvent = (type, clock, jobId, project) => funnelEventWrite(null, clock, { type, idempotencyKey: { kind: 'requestId', value: randomUUID() }, jobId, projectId: project, highlevelContactId: contact, actor, via: 'hub', source: source(), eligibility: { hub: { id: jobId, type: 'job' } } });

  // The walkthrough's booking predates its project; the project, its job and a neighbour come later.
  await store.commit([await booked(at(0))]);
  await store.commit([{ collection: 'jobs', id: W, patch: { type: 'walkthrough', projectId: P } }, { collection: 'jobs', id: J, patch: { type: 'job', projectId: P } },
    { collection: 'projects', id: P, patch: { customerId: 'c1', sourceWalkthroughId: W, sourceRecordId: W, highlevelContactId: contact, createdAt: at(1) } },
    await jobEvent('job.scheduled', at(2), J, P), await jobEvent('job.assigned', at(3), J, P), await jobEvent('job.scheduled', at(4), `job_other${run}`, OTHER)]);

  await t.test('the feed pages by (recordedAt, id) with the types filter and the settle horizon', async () => {
    const now = new Date(at(10)), start = `f1~${at(-1)}~fe_${'0'.repeat(40)}`;
    const seen = []; let cursor = start;
    for (let pages = 0; pages < 10; pages++) {
      const page = await funnelEventsFeed(store, funnelEventsInput({ sinceCursor: cursor, types: ['job.scheduled', 'walkthrough.booked'], limit: 1 }), now);
      seen.push(...page.events.map(event => [event.type, event.recordedAt])); cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    assert.deepEqual(seen.filter(([, recordedAt]) => recordedAt >= at(0) && recordedAt <= at(5)), [['walkthrough.booked', at(0)], ['job.scheduled', at(2)], ['job.scheduled', at(4)]]);
    const early = await funnelEventsFeed(store, funnelEventsInput({ sinceCursor: start }), new Date(at(7.5)));
    assert.deepEqual(early.events.map(event => event.recordedAt), [at(0), at(2)], 'events recorded within 5 minutes of now wait');
  });

  await t.test('a project case reads its events and its source walkthrough\'s earlier ones as one keyset at one readTime', async () => {
    const whole = await funnelCase(store, funnelCaseInput({ projectId: P }), new Date(at(10)));
    assert.deepEqual([whole.events.map(event => event.type), whole.case.matches], [['walkthrough.booked', 'job.scheduled', 'job.assigned'], [{ field: 'projectId', value: P }, { field: 'walkthroughId', value: W }]]);
    const first = await funnelCase(store, funnelCaseInput({ jobId: J, limit: 1 }), new Date(at(10)));
    assert.deepEqual([first.events.map(event => event.type), first.hasMore, first.case.query], [['walkthrough.booked'], true, { field: 'projectId', value: P }]);
    // Committed after page one: a new event for the case and a changed project. Later pages see neither.
    await store.commit([await jobEvent('job.assigned', at(1.5), J, P)]);
    const project = await store.read('projects', P);
    await store.commit([{ collection: 'projects', id: P, revision: project.revision, patch: { highlevelContactId: `${contact}b` } }]);
    const now = new Date(Date.parse(first.asOf) + 1000), pages = [...first.events]; let cursor = first.nextCursor;
    while (cursor) {
      const page = await funnelCase(store, funnelCaseInput({ jobId: J, cursor, limit: 1 }), now);
      assert.deepEqual([page.asOf, page.case.project.highlevelContactId], [first.asOf, contact]);
      pages.push(...page.events); cursor = page.nextCursor;
    }
    assert.deepEqual(pages.map(event => event.id), whole.events.map(event => event.id));
    const fresh = await funnelCase(store, funnelCaseInput({ projectId: P }), now);
    assert.deepEqual([fresh.events.map(event => event.type), fresh.case.project.highlevelContactId], [['walkthrough.booked', 'job.assigned', 'job.scheduled', 'job.assigned'], `${contact}b`]);
    const byContact = await funnelCase(store, funnelCaseInput({ highlevelContactId: contact }), now);
    assert.equal(byContact.events.length, 5);
  });
});
