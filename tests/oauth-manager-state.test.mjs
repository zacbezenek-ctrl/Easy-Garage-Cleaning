import test from 'node:test';
import assert from 'node:assert/strict';
import { createHubActionState, getHubSession, verifyHubActionState, verifyHubSessionToken } from '../functions/_lib/hub-session.js';
import { employeeInvitationStore } from '../functions/_lib/employee-accounts.js';
import { ORIGIN, vaultFirestore, staffEnv, seedAccount, login, cookieFor } from './helpers/vault-fixture.mjs';
import * as drive from '../functions/api/drive-auth.js';
import * as jobber from '../functions/api/jobber-auth.js';

const integrations = [
  { path: 'drive-auth', purpose: 'drive-oauth', endpoint: drive, tokenUrl: 'https://oauth2.googleapis.com/token' },
  { path: 'jobber-auth', purpose: 'jobber-oauth', endpoint: jobber, tokenUrl: 'https://api.getjobber.com/api/oauth/token' },
];

for (const integration of integrations) {
  test(`${integration.path}: signed employee manager state survives provider redirect and refuses changed access`, async t => {
    vaultFirestore(t);
    const env = staffEnv({ EGC_STAFF_ROLE_ACCESS: 'true', GOOGLE_CLIENT_ID: 'synthetic-drive-client', GOOGLE_CLIENT_SECRET: 'synthetic-drive-secret', JOBBER_CLIENT_ID: 'synthetic-jobber-client', JOBBER_CLIENT_SECRET: 'synthetic-jobber-secret' });
    await seedAccount(env, 'Mgr.Account', { extra: { staffRoles: ['manager'] } });
    await seedAccount(env, 'Crew.Account');
    await seedAccount(env, 'Sales.Account', { extra: { staffRoles: ['sales'] } });
    const managerCookie = (await login(env, 'Mgr.Account')).cookie;
    const managerRequest = new Request(`${ORIGIN}/api/${integration.path}`, { headers: { Cookie: managerCookie } });
    const managerSession = await getHubSession(managerRequest, env);
    const firestoreFetch = globalThis.fetch;
    let exchanges = 0;
    globalThis.fetch = async (input, options) => {
      if (new URL(input).hostname === 'firestore.googleapis.com') return firestoreFetch(input, options);
      assert.equal(String(input), integration.tokenUrl);
      exchanges += 1;
      return Response.json({ refresh_token: 'SYNTHETIC-REFRESH-TOKEN' });
    };
    t.after(() => { globalThis.fetch = firestoreFetch; });

    const start = await integration.endpoint.onRequestGet({ request: managerRequest, env });
    assert.equal(start.status, 302);
    const state = new URL(start.headers.get('Location')).searchParams.get('state');
    const payload = JSON.parse(Buffer.from(state.split('.')[0], 'base64url').toString());
    assert.deepEqual([payload.v, payload.p, payload.u, payload.av], [3, integration.purpose, 'Mgr.Account', managerSession.sessionVersion]);
    assert.equal(await verifyHubSessionToken(env, state), null, 'an OAuth state is never a Hub session');
    const callback = (token = state, flags = env) => integration.endpoint.onRequestGet({ request: new Request(`${ORIGIN}/api/${integration.path}?code=synthetic&state=${encodeURIComponent(token)}`), env: flags });
    const deny = async (token = state, flags = env) => {
      const before = exchanges;
      assert.equal((await callback(token, flags)).status, 403);
      assert.equal(exchanges, before, 'invalid state never exchanges a provider code');
    };

    await deny(state + 'tampered');
    const otherPurpose = integration.purpose === 'drive-oauth' ? 'jobber-oauth' : 'drive-oauth';
    assert.equal(await verifyHubActionState(env, state, otherPurpose), null);
    await deny(await createHubActionState(env, otherPurpose, managerSession.user, Date.now(), managerSession));
    await deny(await createHubActionState(env, integration.purpose, managerSession.user), env);
    await deny(state, { ...env, EGC_STAFF_ROLE_ACCESS: 'false' });
    const expired = await createHubActionState(env, integration.purpose, managerSession.user, Date.now() - 11 * 60_000, managerSession);
    await deny(expired);
    for (const cookie of [(await login(env, 'Crew.Account')).cookie, (await login(env, 'Sales.Account')).cookie]) {
      assert.equal((await integration.endpoint.onRequestGet({ request: new Request(`${ORIGIN}/api/${integration.path}`, { headers: { Cookie: cookie } }), env })).status, 403);
    }

    const store = employeeInvitationStore(env);
    const change = async patch => {
      const row = await store.read('Mgr.Account');
      await store.save({ ...row.account, ...patch }, row.version);
    };
    const original = (await store.read('Mgr.Account')).account;
    await change({ staffRoles: ['crew'] });
    await deny();
    await change({ staffRoles: original.staffRoles });
    await change({ sessionVersion: 'rotated-session-version' });
    await deny();
    await change({ sessionVersion: original.sessionVersion });
    await change({ status: 'rejected' });
    await deny();
    await change({ status: original.status });
    await change({ signInReset: { consumedAt: '' } });
    await deny(state, { ...env, EGC_STAFF_PASSWORD_RESET: 'true' });
    await change({ signInReset: original.signInReset || null });
    const collision = { ...env, HUB_AUTH_USERS_JSON: JSON.stringify({ ...JSON.parse(env.HUB_AUTH_USERS_JSON), 'mgr.account': { passwordHash: 'synthetic', role: 'manager' } }) };
    await deny(state, collision);

    const expiring = await createHubActionState(env, integration.purpose, managerSession.user, Date.now(), { ...managerSession, expiresAt: Date.now() + 1000 });
    assert.equal(await verifyHubActionState(env, expiring, integration.purpose, Date.now() + 1001), null, 'expired initiating session refuses the callback');

    const accepted = await callback();
    assert.equal(accepted.status, 200);
    assert.match(await accepted.text(), /SYNTHETIC-REFRESH-TOKEN/);
    assert.equal(exchanges, 1);

    const ownerState = await createHubActionState(env, integration.purpose, 'ZacB');
    assert.equal(JSON.parse(Buffer.from(ownerState.split('.')[0], 'base64url').toString()).v, 2);
    assert.equal((await callback(ownerState)).status, 200, 'configured-owner legacy state remains valid');
    assert.equal(exchanges, 2);
    assert.equal((await integration.endpoint.onRequestGet({ request: new Request(`${ORIGIN}/api/${integration.path}`, { headers: { Cookie: await cookieFor(env, 'ZacB') } }), env })).status, 302);

    // Older approved employee sessions legitimately carry an empty version.
    // They remain bound to that exact value and stop working after rotation.
    await change({ sessionVersion: '' });
    const legacyCookie = (await login(env, 'Mgr.Account')).cookie;
    const legacyStart = await integration.endpoint.onRequestGet({ request: new Request(`${ORIGIN}/api/${integration.path}`, { headers: { Cookie: legacyCookie } }), env });
    assert.equal(legacyStart.status, 302);
    const legacyState = new URL(legacyStart.headers.get('Location')).searchParams.get('state');
    assert.equal(JSON.parse(Buffer.from(legacyState.split('.')[0], 'base64url').toString()).av, '');
    assert.equal((await callback(legacyState)).status, 200);
    await change({ sessionVersion: 'rotated-after-legacy-start' });
    await deny(legacyState);
  });
}
