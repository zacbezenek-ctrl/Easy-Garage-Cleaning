import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, PACKAGES } from '../crew/knock-settings.js';
import { COLLECTED_V3_POLICY, D2D_GARAGE_SCOPE, snapshotCommissionTerms } from '../crew/knock-money.js';
import { loadSettings } from '../functions/_lib/knock-access.js';
import { approveCompensation } from '../functions/_lib/knock-admin.js';
import { decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { createKnockStore } from '../functions/_lib/knock-store.js';
import { knockAdminHandlers } from '../functions/api/knock-admin.js';
import { approvedKnockSettings, call, cookieFor, get, knockEnv, knockWorld, post, uuid } from './helpers/knock-fixture.mjs';

// Synthetic users and terms only; nothing here is a business compensation decision.
const now = '2026-10-20T18:00:00.000Z';
const env = knockEnv({ HUB_AUTH_USERS_JSON: JSON.stringify({
  ZacB: { passwordHash: 'test', role: 'owner', displayName: 'Zac' },
  TylerG: { passwordHash: 'test', role: 'manager', displayName: 'Tyler' },
  'Rep.One': { passwordHash: 'test', role: 'sales', displayName: 'Rep One' },
}) });

// A saved settings record with no approval: the production starting point.
const savedUnapproved = () => {
  const { compensationApproval, planApproval, ...doc } = approvedKnockSettings();
  return doc;
};

/* The shared fake merges every write. Firestore replaces the whole document when a write has
   no updateMask, so after each successful commit this world does the same; a wholesale
   settings write would then erase the approval here, as it would in production (V6). */
function replacingWorld(seed) {
  const world = knockWorld(seed);
  const fetcher = async (env, input, options = {}) => {
    const response = await world.fake.fetcher(env, input, options);
    if (String(input).endsWith(':commit') && response.ok) for (const item of JSON.parse(options.body).writes || []) {
      if (item.update && !item.updateMask) world.fake.put(item.update.name.split('/documents/')[1], decodeFirestoreFields(item.update.fields || {}));
    }
    return response;
  };
  return { ...world, storage: env => createKnockStore(env, fetcher) };
}

function setup(doc = savedUnapproved(), clock = () => now) {
  const world = replacingWorld(doc ? { 'knock_settings/current': doc } : {});
  const handlers = knockAdminHandlers({ storage: world.storage, now: () => new Date(clock()) });
  return { world, handlers };
}

const request = (settings = DEFAULT_SETTINGS, patch = {}) => ({
  action: 'compensation.approve', requestId: uuid(), contract: 'knock-collected-v3', reference: 'synthetic-signed-plan-001', payrollAnchorConfirmed: true,
  collectionPolicy: { ...COLLECTED_V3_POLICY },
  scope: { ...D2D_GARAGE_SCOPE, garageOnlyPackages: ['Garage Transformation', 'The Works'], junkRemovalPackages: ['Quick Clear'] },
  commission: structuredClone(settings.commission), payroll: structuredClone(settings.payroll), ...patch,
});

const approve = async (handlers, body, user = 'ZacB') => call(handlers.post, post('/api/knock-admin', body, await cookieFor(env, user)), env);
const stored = world => world.fake.get('knock_settings/current');

test('compensation stays unapproved by default and only the owner may approve it', async () => {
  const { world, handlers } = setup();
  assert.equal((await loadSettings({ get: async () => stored(world) })).commission.verified, false);
  const views = {};
  for (const user of ['ZacB', 'TylerG']) views[user] = (await call(handlers.get, get('/api/knock-admin?view=settings', await cookieFor(env, user)), env)).body.compensation;
  assert.deepEqual([views.ZacB.verified, views.ZacB.approval, views.ZacB.canApprove, views.ZacB.settingsSaved], [false, null, true, true]);
  assert.equal(views.TylerG.canApprove, false);
  assert.deepEqual(views.ZacB.terms, { contract: 'knock-collected-v3', rate: 0.25, collectionPolicy: COLLECTED_V3_POLICY, scope: D2D_GARAGE_SCOPE, packages: [...PACKAGES] });
  const manager = await approve(handlers, request(), 'TylerG');
  assert.deepEqual([manager.status, manager.body.code], [403, 'knock_owner_required']);
  const rep = await approve(handlers, request(), 'Rep.One');
  assert.deepEqual([rep.status, rep.body.code], [403, 'knock_admin_required']);
  assert.equal(stored(world).compensationApproval, undefined);
  assert.equal(world.fake.calls.filter(item => item.path === ':commit').length, 0);
  // The library function refuses a manager session even when called directly.
  await assert.rejects(approveCompensation(world.storage(env), { user: 'TylerG', role: 'manager', businessAccess: true }, request(), now), { code: 'knock_owner_required' });
  await assert.rejects(approveCompensation(world.storage(env), { user: 'ZacB', role: 'manager', businessAccess: true }, request(), now), { code: 'knock_owner_required' });
});

test('the owner approval records exactly the fields loadSettings verifies, bound to the saved settings', async () => {
  const { world, handlers } = setup();
  const body = request();
  const result = await approve(handlers, body);
  assert.equal(result.status, 200);
  assert.equal(result.body.duplicate, false);
  assert.deepEqual([result.body.compensation.verified, result.body.compensation.approvedAt], [true, now]);
  const doc = stored(world);
  assert.deepEqual(doc.compensationApproval, {
    contract: 'knock-collected-v3', reference: 'synthetic-signed-plan-001', reviewedBy: 'ZacB', reviewedAt: now, payrollAnchorConfirmed: true,
    collectionPolicy: { ...COLLECTED_V3_POLICY },
    // Stored in package order, whatever order the request used.
    scope: { ...D2D_GARAGE_SCOPE, garageOnlyPackages: ['The Works', 'Garage Transformation'], junkRemovalPackages: ['Quick Clear'] },
    commission: DEFAULT_SETTINGS.commission, payroll: DEFAULT_SETTINGS.payroll,
  });
  assert.deepEqual([doc.updatedAt, doc.updatedBy], ['2026-10-01T12:00:00Z', 'test-owner'], 'approving is not a settings edit');
  const receipt = world.fake.get(`knock_receipts/compensation_${body.requestId}`);
  assert.equal(receipt.kind, 'compensation_approval');
  assert.equal(receipt.previous, null);
  const settings = await loadSettings({ get: async () => doc });
  assert.equal(settings.commission.verified, true);
  assert.equal(settings.payroll.anchorVerified, true);
  assert.ok(snapshotCommissionTerms(settings.commission, '2026-10-21T12:00:00Z', 'Garage Transformation'));
  assert.equal(snapshotCommissionTerms(settings.commission, '2026-10-19T12:00:00Z', 'Garage Transformation'), null, 'earlier sales never inherit the new approval');
  const view = (await call(handlers.get, get('/api/knock-admin?view=settings', await cookieFor(env, 'TylerG')), env)).body.compensation;
  assert.deepEqual([view.verified, view.approval.reference, view.approval.reviewedBy, view.approval.matchesSavedSettings], [true, 'synthetic-signed-plan-001', 'ZacB', true]);
});

test('approval retries and identical re-approvals change nothing; a reused request with new terms is refused', async () => {
  const { world, handlers } = setup();
  const body = request();
  await approve(handlers, body);
  const first = stored(world), commits = () => world.fake.calls.filter(item => item.path === ':commit').length;
  const before = commits();
  const retry = await approve(handlers, body);
  assert.deepEqual([retry.status, retry.body.duplicate, retry.body.compensation.verified], [200, true, true]);
  const again = await approve(handlers, { ...body, requestId: uuid() });
  assert.deepEqual([again.status, again.body.duplicate], [200, true]);
  assert.equal(commits(), before, 'no write on a duplicate');
  assert.equal(stored(world).compensationApproval.reviewedAt, first.compensationApproval.reviewedAt);
  const conflict = await approve(handlers, { ...body, reference: 'synthetic-other-plan' });
  assert.deepEqual([conflict.status, conflict.body.code], [409, 'knock_approval_conflict']);
  // A new request with different terms is a deliberate re-approval, with the prior one on its receipt.
  const changed = request(DEFAULT_SETTINGS, { scope: { ...D2D_GARAGE_SCOPE, garageOnlyPackages: ['Garage Transformation'], junkRemovalPackages: [] } });
  assert.equal((await approve(handlers, changed)).body.duplicate, false);
  assert.deepEqual(stored(world).compensationApproval.scope.garageOnlyPackages, ['Garage Transformation']);
  assert.equal(world.fake.get(`knock_receipts/compensation_${changed.requestId}`).previous.reference, 'synthetic-signed-plan-001');
});

test('approval input is validated and nothing is written on a refusal', async () => {
  const cases = [
    [{ requestId: 'not-a-uuid' }, 400, 'knock_invalid_request'],
    [{ contract: 'knock-v1' }, 400, 'knock_approval_contract'],
    [{ reference: ' x ' }, 400, 'knock_approval_reference'],
    [{ reference: 'r'.repeat(121) }, 400, 'knock_approval_reference'],
    [{ reference: 'line\nbreak' }, 400, 'knock_approval_reference'],
    [{ payrollAnchorConfirmed: 'yes' }, 400, 'knock_approval_anchor'],
    [{ collectionPolicy: { ...COLLECTED_V3_POLICY, partialCollections: 'pro_rata' } }, 400, 'knock_approval_policy'],
    [{ collectionPolicy: { ...COLLECTED_V3_POLICY, bonus: 'none' } }, 400, 'knock_approval_policy'],
    [{ collectionPolicy: null }, 400, 'knock_approval_policy'],
    [{ scope: { ...D2D_GARAGE_SCOPE, garageOnlyPackages: [], junkRemovalPackages: [] } }, 400, 'knock_approval_scope'],
    [{ scope: { ...D2D_GARAGE_SCOPE, garageOnlyPackages: ['The Works'], junkRemovalPackages: ['The Works'] } }, 400, 'knock_approval_scope'],
    [{ scope: { ...D2D_GARAGE_SCOPE, garageOnlyPackages: ['Mystery Package'], junkRemovalPackages: [] } }, 400, 'knock_approval_scope'],
    [{ scope: { ...D2D_GARAGE_SCOPE, estimatorStacking: true, garageOnlyPackages: ['The Works'], junkRemovalPackages: [] } }, 400, 'knock_approval_scope'],
    [{ scope: { ...D2D_GARAGE_SCOPE, channel: 'direct_estimator', garageOnlyPackages: ['The Works'], junkRemovalPackages: [] } }, 400, 'knock_approval_scope'],
    [{ commission: { ...DEFAULT_SETTINGS.commission, acceleratorEnabled: true } }, 409, 'knock_settings_changed'],
    [{ payroll: { ...DEFAULT_SETTINGS.payroll, anchorDate: '2026-10-19' } }, 409, 'knock_settings_changed'],
    [{ commission: undefined }, 409, 'knock_settings_changed'],
  ];
  for (const [patch, status, code] of cases) {
    const { world, handlers } = setup();
    const result = await approve(handlers, request(DEFAULT_SETTINGS, patch));
    assert.deepEqual([result.status, result.body.code], [status, code], JSON.stringify(patch));
    assert.equal(stored(world).compensationApproval, undefined);
  }
  // The approval binds to a saved record; defaults alone are not an auditable source.
  const unsaved = setup(null);
  assert.deepEqual((await approve(unsaved.handlers, request())).body.code, 'knock_settings_unsaved');
  assert.equal(unsaved.world.fake.get('knock_settings/current'), null);
  const partial = savedUnapproved(); delete partial.settings.commission.leadOverrideRate;
  assert.equal((await approve(setup(partial).handlers, request())).body.code, 'knock_settings_unsaved');
  // The contract pays 25%; a different saved rate cannot be approved under it.
  const other = savedUnapproved(); other.settings.commission.rate = 0.27;
  const rate = await approve(setup(other).handlers, request(other.settings));
  assert.deepEqual([rate.status, rate.body.code], [409, 'knock_approval_rate']);
});

test('a settings change racing the approval wins; the approval is not written over it', async () => {
  const world = replacingWorld({ 'knock_settings/current': savedUnapproved() });
  let raced = false;
  const storage = e => {
    const store = world.storage(e);
    return { ...store, async commit(writes) {
      if (!raced && writes.some(item => item.update?.name?.endsWith('/knock_settings/current') && item.currentDocument?.updateTime)) {
        raced = true;
        const doc = world.fake.get('knock_settings/current');
        world.fake.put('knock_settings/current', { settings: doc.settings, updatedAt: '2026-10-20T17:59:00Z', updatedBy: 'TylerG' });
      }
      return store.commit(writes);
    } };
  };
  const handlers = knockAdminHandlers({ storage, now: () => new Date(now) });
  const result = await approve(handlers, request());
  assert.deepEqual([result.status, result.body.code], [409, 'knock_conflict']);
  assert.equal(world.fake.get('knock_settings/current').compensationApproval, undefined);
  assert.equal(world.fake.get('knock_settings/current').updatedBy, 'TylerG');
});

test('an approval survives a later unrelated settings save and is shown to admins', async () => {
  const { world, handlers } = setup();
  await approve(handlers, request());
  const cookie = await cookieFor(env, 'TylerG');
  const view = await call(handlers.get, get('/api/knock-admin?view=settings', cookie), env);
  const settings = structuredClone(view.body.settings);
  settings.coverage.hereNowMinutes = 45;
  const saved = await call(handlers.post, post('/api/knock-admin', { action: 'settings.update', settings }, cookie), env);
  assert.deepEqual(saved.body.compensation, { verified: true, approvalInvalidated: false });
  assert.equal((await loadSettings({ get: async () => stored(world) })).commission.verified, true);
});

test('correcting only the reference keeps when the terms were approved; new terms start now', async () => {
  let clock = now;
  const { world, handlers } = setup(savedUnapproved(), () => clock);
  await approve(handlers, request());
  const first = stored(world).compensationApproval;
  // A rep sells offline under the approved terms; the owner fixes the reference before that phone syncs.
  const offlineSoldAt = '2026-10-20T19:00:00.000Z';
  clock = '2026-10-21T18:00:00.000Z';
  const fix = request(DEFAULT_SETTINGS, { reference: 'synthetic-signed-plan-001a' });
  const fixed = await approve(handlers, fix);
  assert.deepEqual([fixed.status, fixed.body.duplicate, fixed.body.referenceOnly, fixed.body.compensation.approvedAt], [200, false, true, now]);
  const doc = stored(world);
  assert.deepEqual(doc.compensationApproval, { ...first, reference: 'synthetic-signed-plan-001a' });
  const receipt = world.fake.get(`knock_receipts/compensation_${fix.requestId}`);
  assert.deepEqual([receipt.referenceOnly, receipt.recordedBy, receipt.recordedAt, receipt.reviewedAt, receipt.previous.reference],
    [true, 'ZacB', clock, now, 'synthetic-signed-plan-001']);
  const settings = await loadSettings({ get: async () => doc });
  assert.ok(snapshotCommissionTerms(settings.commission, offlineSoldAt, 'Garage Transformation'), 'the offline sale still carries the approved terms');
  const retry = await approve(handlers, fix);
  assert.deepEqual([retry.status, retry.body.duplicate, retry.body.referenceOnly], [200, true, true]);
  // A new package classification is new terms: they start now and the earlier offline sale does not inherit them.
  clock = '2026-10-22T18:00:00.000Z';
  const rescoped = request(DEFAULT_SETTINGS, { reference: 'synthetic-signed-plan-002', scope: { ...D2D_GARAGE_SCOPE, garageOnlyPackages: ['The Works'], junkRemovalPackages: ['Quick Clear'] } });
  const moved = await approve(handlers, rescoped);
  assert.deepEqual([moved.status, moved.body.referenceOnly, moved.body.compensation.approvedAt], [200, false, clock]);
  assert.equal(world.fake.get(`knock_receipts/compensation_${rescoped.requestId}`).referenceOnly, false);
  const after = await loadSettings({ get: async () => stored(world) });
  assert.equal(snapshotCommissionTerms(after.commission, offlineSoldAt, 'The Works'), null);
  // An approval that no longer verifies is never 'corrected': approving it again starts now.
  const edited = stored(world);
  world.fake.put('knock_settings/current', { ...edited, settings: { ...edited.settings, payroll: { ...edited.settings.payroll, anchorDate: '2026-10-19' } } });
  clock = '2026-10-23T18:00:00.000Z';
  const changedPayroll = { ...DEFAULT_SETTINGS.payroll, anchorDate: '2026-10-19' };
  const renewed = await approve(handlers, { ...rescoped, requestId: uuid(), payroll: changedPayroll });
  assert.deepEqual([renewed.status, renewed.body.referenceOnly, renewed.body.compensation.approvedAt], [200, false, clock]);
});
