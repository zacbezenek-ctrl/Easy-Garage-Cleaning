import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const enabled = process.env.EGC_FIREBASE_EMULATOR_TEST === '1';

test('hub_audit and confirm_tokens are server-only and their REST contracts hold on real Firestore', { skip: !enabled, timeout: 180000 }, async t => {
  const host = process.env.FIRESTORE_EMULATOR_HOST || '';
  assert.match(host, /^(?:127\.0\.0\.1|localhost):\d{2,5}$/, 'This test may only connect to a loopback Firestore emulator.');
  const projectId = /^demo-[a-z0-9-]+$/.test(process.env.GCLOUD_PROJECT || '') ? process.env.GCLOUD_PROJECT : 'demo-egc-field-rules';
  const require = process.env.EGC_FIREBASE_TEST_MODULES ? createRequire(resolve(process.env.EGC_FIREBASE_TEST_MODULES, 'package.json')) : createRequire(new URL('../package.json', import.meta.url));
  const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing');
  require('firebase/firestore').setLogLevel('silent');
  const [hostname, port] = host.split(':');
  const rules = await readFile(new URL('../firestore.rules', import.meta.url), 'utf8');
  const environment = await initializeTestEnvironment({ projectId, firestore: { host: hostname, port: Number(port), rules } });
  const claims = (username, role = 'crew', business = false) => ({ username, role, business_access: business, assignment_version: 1, assignment_identities: [username], assignment_keys: [username.toLowerCase()] });
  const run = randomUUID().slice(0, 8);
  const { dispatchStorage } = await import('../functions/_lib/dispatch-storage.js');
  const { auditWrite, hubAuditStorage, listAudit } = await import('../functions/_lib/hub-audit.js');
  const { issueConfirmation, consumeConfirmation } = await import('../functions/_lib/confirm-token.js');
  const fetcher = async (_env, url, options = {}) => {
    const target = new URL(url); target.protocol = 'http:'; target.host = host; target.pathname = target.pathname.replace('/projects/egcw-1ec83/', `/projects/${projectId}/`);
    assert.equal(target.hostname, hostname);
    return fetch(target, { ...options, ...(options.body ? { body: options.body.replaceAll('projects/egcw-1ec83/', `projects/${projectId}/`) } : {}), headers: { ...options.headers, Authorization: 'Bearer owner' } });
  };
  const store = { ...dispatchStorage({}, fetcher), ...hubAuditStorage({}, fetcher) };
  const actor = id => ({ id, kind: 'human', role: 'owner' });
  try {
    const jobId = `secb-job-${run}`, owner = `secb-owner-${run}`;
    const created = auditWrite({ actor: actor(owner), via: 'hub', action: 'job.create', entity: { collection: 'jobs', id: jobId }, after: { status: 'scheduled', apiKey: 'CANARY' }, requestId: randomUUID(), now: '2026-09-21T15:00:00.000Z' });
    await store.commit([{ collection: 'jobs', id: jobId, patch: { type: 'job', status: 'scheduled' } }, created]);
    const job = await store.read('jobs', jobId);

    await t.test('an audit entry and its change land together or not at all', async () => {
      const rejected = auditWrite({ actor: actor(owner), via: 'hub', action: 'job.cancel', entity: { collection: 'jobs', id: jobId }, requestId: randomUUID(), now: '2026-09-22T15:00:00.000Z' });
      // A create collision is ALREADY_EXISTS (409). A stale updateTime is
      // FAILED_PRECONDITION (HTTP 400), which dispatchStorage reports as an
      // unknown outcome. Either way Firestore applies neither write.
      await assert.rejects(store.commit([{ collection: 'jobs', id: jobId, patch: { status: 'cancelled' } }, rejected]), error => error.code === 'dispatch_revision_conflict');
      await assert.rejects(store.commit([{ collection: 'jobs', id: jobId, revision: '2000-01-01T00:00:00.000000Z', patch: { status: 'cancelled' } }, rejected]), error => error.code === 'dispatch_outcome_unknown');
      assert.equal(await store.read('hub_audit', rejected.id), null);
      assert.equal((await store.read('jobs', jobId)).status, 'scheduled');
      const saved = await store.read('hub_audit', created.id);
      assert.equal(saved.entityKey, `jobs/${jobId}`); assert.ok(!JSON.stringify(saved).includes('CANARY'));
      await assert.rejects(store.commit([created]), error => error.code === 'dispatch_revision_conflict', 'An entry id can never be written twice.');
      const cancelled = auditWrite({ actor: actor(owner), via: 'mcp', action: 'job.cancel', entity: { collection: 'jobs', id: jobId }, before: { status: 'scheduled' }, after: { status: 'cancelled' }, requestId: randomUUID(), now: '2026-09-22T15:00:00.000Z' });
      await store.commit([{ collection: 'jobs', id: jobId, revision: job.revision, patch: { status: 'cancelled' } }, cancelled]);
      const other = auditWrite({ actor: actor(`secb-other-${run}`), via: 'hub', action: 'job.note', entity: { collection: 'jobs', id: jobId }, now: '2026-09-23T15:00:00.000Z' });
      await store.commit([other]);
    });

    await t.test('the structured audit query filters, orders and pages on real Firestore', async () => {
      const entity = `jobs/${jobId}`;
      const all = await listAudit(store, { entity });
      assert.deepEqual(all.entries.map(item => item.action), ['job.note', 'job.cancel', 'job.create']);
      assert.deepEqual((await listAudit(store, { entity, actor: owner })).entries.map(item => item.action), ['job.cancel', 'job.create']);
      assert.deepEqual((await listAudit(store, { entity, startDate: '2026-09-22', endDate: '2026-09-23' })).entries.map(item => item.action), ['job.cancel']);
      assert.deepEqual((await listAudit(store, { actor: owner, endDate: '2026-09-22' })).entries.map(item => item.action), ['job.create']);
      const first = await listAudit(store, { entity, limit: '2' });
      assert.equal(first.entries.length, 2); assert.ok(first.nextCursor);
      const second = await listAudit(store, { entity, limit: '2', cursor: first.nextCursor });
      assert.deepEqual(second.entries.map(item => item.action), ['job.create']); assert.equal(second.nextCursor, null);
      const ranged = await listAudit(store, { entity, startDate: '2026-09-21', endDate: '2026-09-24', limit: '1' });
      assert.deepEqual(ranged.entries.map(item => item.action), ['job.note']);
      assert.deepEqual((await listAudit(store, { entity, startDate: '2026-09-21', endDate: '2026-09-24', limit: '5', cursor: ranged.nextCursor })).entries.map(item => item.action), ['job.cancel', 'job.create']);
      assert.deepEqual(all.entries[1].changedKeys, ['status']);
    });

    await t.test('only one concurrent consume of a confirmation succeeds on real Firestore', async () => {
      const env = { HUB_SESSION_SECRET: 'synthetic-hub-session-root-secret-0123456789abcdef' };
      const expected = { actorId: owner, action: 'invoice.send', entityId: jobId, payload: { amountCents: 45000 }, now: '2026-09-22T12:01:00.000Z' };
      const issued = await issueConfirmation(env, { ...expected, now: '2026-09-22T12:00:00.000Z' });
      const results = await Promise.allSettled([0, 1, 2, 3].map(index => consumeConfirmation(env, store, issued.token, { ...expected, requestId: randomUUID() }, [{ collection: 'jobs', id: `secb-send-${run}-${index}`, patch: { type: 'job', index } }])));
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'confirm_token_used'), results.map(result => result.reason?.code).join());
      const applied = await Promise.all([0, 1, 2, 3].map(index => store.read('jobs', `secb-send-${run}-${index}`)));
      assert.equal(applied.filter(Boolean).length, 1);
      assert.equal((await store.read('confirm_tokens', issued.confirmationId)).action, 'invoice.send');
      // A stale caller write rolls back the token too, so it stays usable.
      const next = await issueConfirmation(env, { ...expected, now: '2026-09-22T12:00:00.000Z' });
      await assert.rejects(consumeConfirmation(env, store, next.token, expected, [{ collection: 'jobs', id: jobId, revision: '2000-01-01T00:00:00.000000Z', patch: { status: 'sent' } }]), error => error.code === 'dispatch_outcome_unknown');
      assert.equal(await store.read('confirm_tokens', next.confirmationId), null);
      const current = await store.read('jobs', jobId), requestId = randomUUID();
      const confirmed = [{ collection: 'jobs', id: jobId, revision: current.revision, patch: { invoiceStatus: 'sending' } }];
      assert.equal((await consumeConfirmation(env, store, next.token, { ...expected, requestId }, confirmed)).replayed, false);
      // Retrying the completed request, whose revision is now stale, is reported as a replay, never as a fresh change.
      assert.equal((await consumeConfirmation(env, store, next.token, { ...expected, requestId }, confirmed)).replayed, true);
      await assert.rejects(consumeConfirmation(env, store, next.token, { ...expected, requestId: randomUUID() }, confirmed), error => error.code === 'confirm_token_used');
    });

    await t.test('no browser SDK session can read or write audit entries or confirmation receipts', async () => {
      const contexts = [environment.unauthenticatedContext().firestore(), environment.authenticatedContext('crew-one', claims('crew1')).firestore(), environment.authenticatedContext('manager', claims('zacb', 'owner', true)).firestore()];
      const receipt = (await listAudit(store, { entity: `jobs/${jobId}`, limit: '1' })).entries[0].id;
      for (const db of contexts) {
        for (const path of [`hub_audit/${created.id}`, `hub_audit/${receipt}`, `confirm_tokens/${'a'.repeat(64)}`]) {
          await assertFails(db.doc(path).get());
          await assertFails(db.doc(path).set({ action: 'forged' }));
          await assertFails(db.doc(path).update({ action: 'forged' }));
          await assertFails(db.doc(path).delete());
        }
        await assertFails(db.collection('hub_audit').get());
        await assertFails(db.collection('confirm_tokens').get());
        await assertFails(db.doc(`hub_audit/forged-${run}`).set({ action: 'forged' }));
      }
    });
  } finally { await environment.cleanup(); }
});
