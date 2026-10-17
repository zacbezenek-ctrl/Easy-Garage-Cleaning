import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ACCOUNTS, responses, seedDirectoryTarget, staffSessions } from './helpers/auth-roles-harness.mjs';

// AUTH-ROLES: with EGC_STAFF_ROLE_ACCESS anything but exactly "true", every staff kind gets
// byte-identical responses from every endpoint the role model governs (the staff directory's
// views and role change included), with stored-role permissions off and on. The snapshot was
// recorded with UPDATE_SNAPSHOTS=1 by running this file and its harness, and nothing else of
// AUTH-ROLES, on the code before AUTH-ROLES: the integration branch at 7747762 (GUSTO-EXPORT,
// which shapes the staff directory's answers). Never re-record it on a tree that has AUTH-ROLES.
const ENVS = {
  off: {},
  permissions: { EGC_STAFF_ROLE_PERMISSIONS: 'true' },
  accessUpper: { EGC_STAFF_ROLE_ACCESS: 'TRUE' },
  accessOne: { EGC_STAFF_ROLE_ACCESS: '1' },
  accessFalsePermissions: { EGC_STAFF_ROLE_ACCESS: 'false', EGC_STAFF_ROLE_PERMISSIONS: 'true' },
};
const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
// TEAM-LEAD (owner decision D6, 2026-10-17) added the team_lead role (staff-roles.js) and the door_to_door skill
// (staff-skills.js, catalog v2) to the catalogs every staff kind reads, whatever the flags. Exactly those additions are
// taken back out of each answer here, so every other byte still compares with the pre-AUTH-ROLES snapshot, which stays
// as recorded. Anything else that changes still fails this test.
const CATALOG_ADDITIONS = [['"team_lead",', ''], ['"team_lead":[],', ''], [',{"id":"door_to_door","label":"Door-to-door sales"}', ''], ['"2026-10-staff-skills-v2"', '"2026-09-staff-skills-v1"']];
const withoutAdditions = body => CATALOG_ADDITIONS.reduce((text, [added, before]) => text.replaceAll(added, before), body);
function render(matrix) {
  const bodies = new Map(), index = [];
  for (const [key, rows] of matrix) for (const [label, body] of rows) { bodies.set(sha(body), body); index.push(`${key} | ${label} | ${sha(body)}`); }
  return `${index.join('\n')}\n${[...bodies].sort(([a], [b]) => a.localeCompare(b)).map(([hash, body]) => `======== ${hash}\n${body}\n`).join('')}`;
}
const snapshot = new URL('./snapshots/auth-roles-flag-off.snap', import.meta.url);

test('with EGC_STAFF_ROLE_ACCESS off every staff kind gets byte-identical responses to before AUTH-ROLES', async t => {
  const { env, cookies, fire } = await staffSessions(t);
  const reseed = await seedDirectoryTarget(env, fire);
  const matrix = [];
  for (const [mode, flags] of Object.entries(ENVS)) {
    // Each mode starts from the seeded vault, so one mode's staff directory demotion does not change the next.
    reseed();
    for (const user of ACCOUNTS) matrix.push([`${mode} ${user}`, (await responses(cookies[user], { ...env, ...flags })).map(([label, body]) => [label, withoutAdditions(body)])]);
  }
  const text = render(matrix);
  if (process.env.UPDATE_SNAPSHOTS === '1') { mkdirSync(new URL('./snapshots/', import.meta.url), { recursive: true }); writeFileSync(snapshot, text); }
  assert.ok(existsSync(snapshot), 'the baseline snapshot was recorded from the code before AUTH-ROLES');
  assert.equal(text, readFileSync(snapshot, 'utf8'), 'a flag-off response changed');
});
