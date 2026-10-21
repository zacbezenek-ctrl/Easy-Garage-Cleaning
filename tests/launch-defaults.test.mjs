import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest } from '../functions/_middleware.js';
import { LAUNCH_DEFAULTS, applyLaunchDefaults } from '../functions/_lib/launch-defaults.js';
import { crewAutoAssignEnabled } from '../functions/_lib/dispatch-crew-assign.js';
import { jobMaterialsEnabled } from '../functions/_lib/job-materials.js';
import { quoteBuilderEnabled } from '../functions/_lib/catalog-store.js';
import { knockJobBridgeEnabled } from '../functions/_lib/knock-bridge.js';
import { staffDirectoryEnabled } from '../functions/_lib/staff-directory.js';
import { staffRoleAccessEnabled, staffRolePermissionsEnabled } from '../functions/_lib/staff-roles.js';
import { walkthroughVisitEnabled } from '../functions/_lib/walkthrough-visit.js';
import { walkthroughNotesEnabled } from '../functions/_lib/walkthrough-notes.js';

// Updated deliberately: staff role access (owner decision 2026-10-21), staff roles (owner decision 2026-10-20) and the walkthrough recorder and its notes (owner
// decision 2026-10-19) join the launch defaults.
const NAMES = ['EGC_DISPATCH_CREW_AUTO_ASSIGN', 'EGC_JOB_MATERIALS', 'EGC_KNOCK_JOB_BRIDGE', 'EGC_QUOTE_BUILDER_ENABLED', 'EGC_STAFF_DIRECTORY_ENABLED', 'EGC_STAFF_ROLE_ACCESS', 'EGC_STAFF_ROLE_PERMISSIONS', 'EGC_WALKTHROUGH_NOTES', 'EGC_WALKTHROUGH_VISIT_ENABLED'];
const readers = env => [crewAutoAssignEnabled(env), jobMaterialsEnabled(env), quoteBuilderEnabled(env), knockJobBridgeEnabled(env), staffDirectoryEnabled(env), staffRolePermissionsEnabled(env), walkthroughVisitEnabled(env), walkthroughNotesEnabled(env)];

test('the launch defaults are exactly the nine switches the owner asked to have on', () => {
  assert.deepEqual(Object.keys(LAUNCH_DEFAULTS).sort(), NAMES);
  assert.ok(Object.values(LAUNCH_DEFAULTS).every(value => value === 'true'));
  for (const held of ['EGC_GHL_SCHEDULE_MIRROR', 'EGC_GHL_D2D_TAGS', 'EGC_DISPATCH_WINDOWED_READS']) assert.equal(held in LAUNCH_DEFAULTS, false, held);
});

test('staff roles come on with role access: stored roles grant Hub access, and Cloudflare "false" takes it back', () => {
  const env = applyLaunchDefaults({});
  assert.equal(staffDirectoryEnabled(env), true);
  assert.equal(staffRolePermissionsEnabled(env), true);
  assert.equal(staffRoleAccessEnabled(env), true);
  assert.equal(staffRoleAccessEnabled(applyLaunchDefaults({ EGC_STAFF_ROLE_ACCESS: 'false' })), false);
});

test('unset switches become "true"; a value set in Cloudflare always wins, so "false" keeps one off', () => {
  const env = { HIGHLEVEL_LOCATION_ID: 'loc', EGC_JOB_MATERIALS: 'false', EGC_KNOCK_JOB_BRIDGE: '', EGC_WALKTHROUGH_NOTES: 'false' };
  assert.equal(applyLaunchDefaults(env), env);
  assert.deepEqual(env, { HIGHLEVEL_LOCATION_ID: 'loc', EGC_JOB_MATERIALS: 'false', EGC_KNOCK_JOB_BRIDGE: '', EGC_WALKTHROUGH_NOTES: 'false', EGC_DISPATCH_CREW_AUTO_ASSIGN: 'true', EGC_QUOTE_BUILDER_ENABLED: 'true', EGC_STAFF_DIRECTORY_ENABLED: 'true', EGC_STAFF_ROLE_PERMISSIONS: 'true', EGC_STAFF_ROLE_ACCESS: 'true', EGC_WALKTHROUGH_VISIT_ENABLED: 'true' });
  assert.deepEqual(readers(env), [true, false, true, false, true, true, true, false]);
  assert.deepEqual(readers(applyLaunchDefaults({})), [true, true, true, true, true, true, true, true]);
  // Role access includes role permissions, so turning them off takes both.
  const off = applyLaunchDefaults({ EGC_STAFF_DIRECTORY_ENABLED: 'false', EGC_STAFF_ROLE_PERMISSIONS: 'false', EGC_STAFF_ROLE_ACCESS: 'false' });
  assert.deepEqual(readers(off).slice(4, 6), [false, false], 'Cloudflare "false" turns the staff switches off again');
});

test('a read-only env never fails the request and keeps every switch off', () => {
  const env = Object.freeze({ OTHER: 'x' });
  assert.doesNotThrow(() => applyLaunchDefaults(env));
  assert.deepEqual(readers(env), [false, false, false, false, false, false, false, false]);
  assert.equal(applyLaunchDefaults(undefined), undefined);
  assert.equal(applyLaunchDefaults(null), null);
});

test('the site middleware applies the defaults before any handler reads the env', async () => {
  const env = { EGC_QUOTE_BUILDER_ENABLED: 'false' };
  let seen = null;
  const response = await onRequest({ request: new Request('https://easygaragecleaning.com/api/catalog'), env,
    next: async () => { seen = readers(env); return new Response('ok', { headers: { 'Content-Type': 'text/plain' } }); } });
  assert.equal(response.status, 200);
  assert.deepEqual(seen, [true, true, false, true, true, true, true, true], 'auto crew, materials, the bridge, staff roles, the recorder and its notes on; the builder stays off where Cloudflare says "false"');
});
