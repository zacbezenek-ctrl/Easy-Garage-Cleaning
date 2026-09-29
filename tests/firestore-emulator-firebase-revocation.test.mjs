import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const enabled = process.env.EGC_FIREBASE_EMULATOR_TEST === '1';
const NOW = '2026-09-22T12:00:00.000Z';
const at = minutes => new Date(Date.parse(NOW) + minutes * 60000).toISOString();

test('the Firebase session revocation record is server-only and its compare-and-set holds on real Firestore', { skip: !enabled, timeout: 180000 }, async t => {
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
  const { dispatchStorage } = await import('../functions/_lib/dispatch-storage.js');
  const { createFirebaseRevocationService, FIREBASE_REVOCATION_COLLECTION } = await import('../functions/_lib/firebase-revocation.js');
  const fetcher = async (_env, url, options = {}) => {
    const target = new URL(url); target.protocol = 'http:'; target.host = host; target.pathname = target.pathname.replace('/projects/egcw-1ec83/', `/projects/${projectId}/`);
    assert.equal(target.hostname, hostname);
    return fetch(target, { ...options, ...(options.body ? { body: options.body.replaceAll('projects/egcw-1ec83/', `projects/${projectId}/`) } : {}), headers: { ...options.headers, Authorization: 'Bearer owner' } });
  };
  const path = `${FIREBASE_REVOCATION_COLLECTION}/state`;
  const clear = () => environment.withSecurityRulesDisabled(context => context.firestore().doc(path).delete());
  // A store whose next commit first lets another writer change the record, so
  // the service's own commit carries a stale updateTime.
  const storage = dispatchStorage({}, fetcher), failures = [];
  let interleave = null;
  const store = {
    read: storage.read,
    async commit(writes) {
      if (interleave) { const other = interleave; interleave = null; await other(); }
      try { return await storage.commit(writes); } catch (error) { failures.push(error.code); throw error; }
    },
  };
  const revoker = answer => { const calls = []; const revoke = async (uid, validSince) => { calls.push({ uid, validSince }); const result = answer(uid); if (result instanceof Error) throw result; return result; }; revoke.calls = calls; return revoke; };
  const denied = () => Object.assign(new Error('synthetic denial'), { code: 'firebase_revocation_permission_denied' });
  const staff = [{ user: 'ZacB', role: 'owner', businessAccess: true }, { user: 'SyntheticLead', role: 'crew_lead', businessAccess: false }];
  try {
    await clear();

    await t.test('a failed revocation creates the record, and maintenance updates it under the stored revision', async () => {
      const revoke = revoker(() => denied());
      const service = createFirebaseRevocationService({ store, revoke });
      assert.equal((await service.revokeStaff(['JamieR'], 'account_status', NOW)).status, 'revocation_pending');
      const created = await service.read();
      assert.match(created.revision, /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(created.pending, [{ uid: 'hub:jamier', reason: 'account_status', requestedAt: NOW, attempts: 1, lastAttemptAt: NOW, lastError: 'permission_denied' }]);
      assert.equal(created.staticRoster, null);
      assert.equal((await service.maintain(staff, at(1), created)).firebaseRevocationState, 'revocation_pending');
      const updated = await service.read();
      assert.notEqual(updated.revision, created.revision);
      assert.deepEqual(updated.staticRoster, [{ uid: 'hub:syntheticlead', fingerprint: 'crew_lead|false' }, { uid: 'hub:zacb', fingerprint: 'owner|true' }]);
      assert.deepEqual(updated.pending, created.pending, 'nothing is retried inside the retry window');
      assert.equal(revoke.calls.length, 1);
    });

    await t.test('a stale write is refused by Firestore and re-applied to the fresh record', async () => {
      const revoke = revoker(() => denied());
      const service = createFirebaseRevocationService({ store, revoke });
      interleave = async () => {
        const current = await storage.read(FIREBASE_REVOCATION_COLLECTION, 'state');
        await storage.commit([{ collection: FIREBASE_REVOCATION_COLLECTION, id: 'state', revision: current.revision, patch: { pending: [...current.pending, { uid: 'hub:other', reason: 'static_removed', requestedAt: at(2), attempts: 0, lastAttemptAt: '', lastError: '' }] } }]);
      };
      failures.length = 0;
      assert.equal((await service.revokeStaff(['SyntheticCrew'], 'account_status', at(3))).status, 'revocation_pending');
      assert.equal(failures.length, 1, 'Firestore refused the stale updateTime once');
      assert.ok(['dispatch_revision_conflict', 'dispatch_outcome_unknown'].includes(failures[0]), failures[0]);
      assert.deepEqual((await service.read()).pending.map(entry => [entry.uid, entry.requestedAt]), [['hub:jamier', NOW], ['hub:other', at(2)], ['hub:syntheticcrew', at(3)]]);
      assert.equal(revoke.calls.length, 1, 'the provider is never called again to save a result');
    });

    await t.test('successful retries clear the queue and prove the grant', async () => {
      const revoke = revoker(() => 'revoked');
      const service = createFirebaseRevocationService({ store, revoke });
      const summary = await service.maintain(staff, at(20));
      assert.deepEqual(revoke.calls.map(call => call.uid), ['hub:jamier', 'hub:other', 'hub:syntheticcrew']);
      assert.deepEqual(summary, { firebaseRevocation: true, firebaseRevocationState: 'verified', firebaseRevocationPending: 0, firebaseRevocationError: '' });
      const state = await service.read();
      assert.deepEqual(state.pending, []);
      assert.equal(state.verifiedAt, at(20));
      assert.deepEqual(state.revoked.map(entry => [entry.uid, entry.through]), [['hub:jamier', NOW], ['hub:other', at(2)], ['hub:syntheticcrew', at(3)]]);
    });

    await t.test('an intent recorded before an account change round-trips and is settled by its revocation', async () => {
      const revoke = revoker(() => 'revoked');
      const service = createFirebaseRevocationService({ store, revoke });
      await service.intend(['JamieR'], 'account_status', at(30));
      assert.deepEqual((await service.read()).intents, [{ uid: 'hub:jamier', reason: 'account_status', at: at(30) }]);
      assert.deepEqual(await service.revokeStaff(['JamieR'], 'account_status', at(31), at(30)), { status: 'revoked' });
      const state = await service.read();
      assert.deepEqual(state.intents, []);
      assert.deepEqual(state.revoked.find(entry => entry.uid === 'hub:jamier'), { uid: 'hub:jamier', through: at(31) });
    });

    await t.test('an admit stamp round-trips, re-stamps a matching entry and refuses a reconciliation that read before it', async () => {
      const revoke = revoker(() => 'revoked');
      const service = createFirebaseRevocationService({ store, revoke });
      const manager = { user: 'Mgr.Account', role: 'manager', businessAccess: true };
      await service.admit(manager, at(40));
      const known = await service.read();
      assert.deepEqual(known.staticRoster.find(entry => entry.uid === 'hub:mgr.account'), { uid: 'hub:mgr.account', fingerprint: 'manager|true', at: at(40) });
      // A later admit of the same claims writes its stamp, so the reconciliation's stale updateTime is refused.
      interleave = () => service.admit(manager, `${at(41).slice(0, 17)}05.000Z`);
      failures.length = 0;
      await service.maintain(staff, at(41), known);
      assert.equal(failures.length, 1, 'Firestore refused the reconciliation that read before the admit');
      const state = await service.read();
      assert.equal(state.staticRoster.some(entry => entry.uid === 'hub:mgr.account'), false);
      assert.deepEqual(state.pending.map(entry => [entry.uid, entry.reason, entry.requestedAt]), [['hub:mgr.account', 'static_removed', `${at(41).slice(0, 17)}36.000Z`]]);
      assert.deepEqual(revoke.calls, [{ uid: 'hub:mgr.account', validSince: Math.floor(Date.parse(at(41)) / 1000) }], 'sessions from before the Hub load end at once');
    });

    await t.test('no browser SDK session can read, list or forge the revocation record', async () => {
      const contexts = [environment.unauthenticatedContext().firestore(), environment.authenticatedContext('hub:syntheticcrew', claims('SyntheticCrew')).firestore(), environment.authenticatedContext('hub:zacb', claims('ZacB', 'owner', true)).firestore()];
      for (const db of contexts) {
        await assertFails(db.doc(path).get());
        await assertFails(db.doc(path).set({ pending: [] }));
        await assertFails(db.doc(path).update({ pending: [] }));
        await assertFails(db.doc(path).delete());
        await assertFails(db.collection(FIREBASE_REVOCATION_COLLECTION).get());
        await assertFails(db.doc(`${FIREBASE_REVOCATION_COLLECTION}/forged`).set({ pending: [] }));
      }
    });
  } finally {
    await clear().catch(() => {});
    await environment.cleanup();
  }
});
