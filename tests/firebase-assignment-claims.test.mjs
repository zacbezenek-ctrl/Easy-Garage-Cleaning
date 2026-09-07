import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { createJobAssignmentAccess } from '../functions/_lib/job-assignment.js';
import { onRequestGet } from '../functions/api/firebase-session.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = {
  type: 'service_account', project_id: 'egcw-1ec83',
  client_email: 'synthetic-assignment@egcw-1ec83.iam.gserviceaccount.com',
  private_key: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }),
};
const variants = ['John.Smith', 'John_Smith', 'John-Smith', 'JohnSmith', 'JohnSmith2'];
const profile = (displayName, role = 'crew') => ({ passwordHash: 'synthetic', displayName, role });
const environment = users => ({
  HUB_SESSION_SECRET: 'synthetic-assignment-token-session',
  HUB_AUTH_USERS_JSON: JSON.stringify(users), FIREBASE_API_KEY: 'firebase-test-assignment-token',
  FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(account),
});

async function tokenFor(env, user) {
  const cookie = (await createHubSessionCookie(env, user)).split(';')[0];
  const response = await onRequestGet({ env, request: new Request('https://easygaragecleaning.com/api/firebase-session?assignment_identities=Imposter', { headers: { Cookie: cookie } }) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const { token } = await response.json();
  const [header, body, signature] = token.split('.');
  assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${body}`), keys.publicKey, Buffer.from(signature, 'base64url')), true);
  return JSON.parse(Buffer.from(body, 'base64url'));
}

test('signed Firebase identities preserve punctuation and suffixes and ignore requested claim overrides', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('No roster is needed for canonical names'); });
  const env = environment(Object.fromEntries(variants.map(user => [user, profile(user)])));
  for (const user of variants) {
    const payload = await tokenFor(env, user);
    assert.equal(payload.uid, `hub:${user.toLowerCase()}`);
    assert.equal(payload.claims.business_access, false);
    assert.equal(payload.claims.assignment_version, 1);
    assert.deepEqual(payload.claims.assignment_identities, [user]);
    assert.deepEqual(payload.claims.assignment_keys, [user.toLowerCase()]);
    assert.equal(payload.claims.assignment_identities.includes('Imposter'), false);
  }
  assert.equal(calls, 0);
});

test('Firebase legacy alias claims use the same exact roster resolution as server job access', async t => {
  let queries = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.match(String(url), /documents:runQuery/);
    assert.equal(JSON.parse(init.body).structuredQuery.where.fieldFilter.value.stringValue, 'employee_account_v1');
    queries++;
    return Response.json([{ readTime: '2026-09-07T00:00:00Z' }]);
  });
  const env = environment({ 'John.Smith': profile('John Q. Smith'), 'John-Smith': profile('Different Person') });
  const claims = (await tokenFor(env, 'John.Smith')).claims;
  assert.deepEqual(claims.assignment_identities, ['John.Smith', 'John Q. Smith']);
  assert.deepEqual(claims.assignment_keys, ['john.smith', 'john q. smith']);
  assert.deepEqual(claims.assignment_identities, await createJobAssignmentAccess(env, { user: 'John.Smith', displayName: 'John Q. Smith' }).identities());
  const duplicateEnv = environment({ 'John.Smith': profile('John Q. Smith'), 'John-Smith': profile('John Q. Smith') });
  assert.deepEqual((await tokenFor(duplicateEnv, 'John.Smith')).claims.assignment_identities, ['John.Smith']);
  const usernameCollision = environment({ 'John.Smith': profile('John-Smith'), 'John-Smith': profile('Different Person') });
  assert.deepEqual((await tokenFor(usernameCollision, 'John.Smith')).claims.assignment_identities, ['John.Smith']);
  assert.equal(queries, 4);
});

test('an unavailable alias roster cannot break canonical crew or existing business sign-in', async t => {
  let queries = 0;
  t.mock.method(globalThis, 'fetch', async () => { queries++; return Response.json({}, { status: 503 }); });
  const env = environment({ 'John.Smith': profile('John Q. Smith'), ZacB: profile('Zac', 'owner'), TylerG: profile('Tyler', 'manager'), AlexK: profile('Alex', 'sales') });
  const crew = (await tokenFor(env, 'John.Smith')).claims;
  assert.deepEqual(crew.assignment_identities, ['John.Smith']);
  assert.deepEqual(crew.assignment_keys, ['john.smith']);
  assert.equal(crew.display_name, 'John Q. Smith', 'the display label does not become an authorization alias');
  for (const user of ['ZacB', 'TylerG', 'AlexK']) {
    const claims = (await tokenFor(env, user)).claims;
    assert.equal(claims.business_access, true);
    assert.deepEqual(claims.assignment_identities, [user]);
  }
  assert.equal(queries, 1, 'business access must not depend on the alias roster');
});

test('rules consume only signed identity claims and safely select explicit crew before legacy text', () => {
  const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
  const body = name => rules.match(new RegExp(`function ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n    \\}`))?.[1] || '';
  assert.doesNotMatch(rules, /request\.auth\.token\.display_name/);
  assert.match(body('assignmentIdentities'), /assignment_version/);
  assert.match(body('assignmentIdentities'), /assignment_identities/);
  assert.match(body('assignmentKeys'), /username\.trim\(\)\.lower\(\)/);
  assert.match(body('assignedToUser'), /assignedDataMatches\(data, request\.auth\.token\.assignment_keys/);
  assert.match(body('assignedDataMatches'), /'assignedCrew' in data && data\.assignedCrew is list && data\.assignedCrew\.size\(\) > 0\s*\? assignedCrewMatches\(data\.assignedCrew, keys, username\)\s*:/);
  assert.match(body('assignedDataMatches'), /'assignedTo' in data && data\.assignedTo is string/);
  assert.match(body('assignedDataMatches'), /data\.assignedTo\.trim\(\)\.lower\(\)\.split/);
  assert.doesNotMatch(body('assignedCrewMatches'), /\.join\(/);
  assert.deepEqual([...body('assignedCrewMatches').matchAll(/assignedCrewMemberMatches\(crew\[(\d+)\], keys, username\)/g)].map(match => Number(match[1])), Array.from({ length: 20 }, (_, index) => index));
  assert.match(body('assignedCrewMemberMatches'), /value is string/);
  for (const key of ['username', 'user', 'id']) {
    assert.ok(body('assignedCrewMemberMatches').includes(`'${key}' in value ? (value.${key} in ['', null]`));
    assert.match(body('assignedCrewMemberMatches'), new RegExp(`value\\.${key}\\.trim\\(\\)\\.lower\\(\\) == username`));
  }
  assert.match(body('assignedCrewMemberMatches'), /value\.name\.trim\(\)\.lower\(\) in keys/);
  assert.match(body('ownAvailability'), /employee\.trim\(\)\.lower\(\) in assignmentKeys\(\)/);
  assert.match(body('assignedUpdateIsSafe'), /get\('assignedCrew', \[\]\) == resource\.data\.get\('assignedCrew', \[\]\)/);
  assert.match(body('assignedUpdateIsSafe'), /get\('assignedTo', ''\) == resource\.data\.get\('assignedTo', ''\)/);
  assert.equal((body('assignedUpdateIsSafe').match(/assignedToUser\(/g) || []).length, 1);
  assert.match(body('assignedUpdateIsSafe'), /!changed\.hasAny\(\['status', 'pipelineStatus', 'payment', 'invoice'\]\)/);
  assert.match(body('assignedStageUpdateIsSafe'), /!request\.resource\.data\.diff\(resource\.data\)\.affectedKeys\(\)\.hasAny\(\['status', 'pipelineStatus'\]\)/);
  assert.match(body('changedAssignedStageIsSafe'), /currentStatus == 'paid' && currentPipeline == 'paid'/);
  assert.match(body('changedAssignedStageIsSafe'), /nextStatus in crewStages && nextPipeline in crewStages/);
  assert.match(body('changedAssignedStageIsSafe'), /savedPaymentIsSettled\(\)/);
  assert.match(body('savedPaymentIsSettled'), /invoice\.get\('status', ''\) == 'paid'/);
  assert.match(body('savedPaymentIsSettled'), /invoice\.get\('balance', 1\) < 0\.01/);
  assert.match(body('savedPaymentIsSettled'), /payment\.get\('amount', 0\) >= invoice\.amount - 0\.01/);
  assert.match(body('assignedInvoiceUpdateIsSafe'), /affectedKeys\(\)\.hasOnly\(\['updatedAt'\]\)/);
});
