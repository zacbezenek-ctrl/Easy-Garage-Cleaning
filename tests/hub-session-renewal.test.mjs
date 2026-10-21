import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { ORIGIN, cookieFor, jsonRequest, login, seedAccount, staffEnv, vaultFirestore } from './helpers/vault-fixture.mjs';
import { createHubSessionCookie, createHubSessionToken, getHubSession, hashHubCredential, hubSessionIdentity, renewHubSessionCookie, verifyHubSessionToken } from '../functions/_lib/hub-session.js';
import { writeGustoRecord } from '../functions/_lib/gusto-store.js';
import * as gustoAuth from '../functions/api/gusto-auth.js';
import { employeeAccountsHandlers } from '../functions/api/employee-accounts.js';
import * as hubAuth from '../functions/api/hub-auth.js';
import { onRequest as middleware } from '../functions/_middleware.js';

// STAFF-SESSION (owner decision, 2026-10-19): staff stay signed in. A Hub session lasts 7 days from when it was issued,
// an API request on a session issued over an hour ago gets it back with a fresh 7 days, so it ends only after 7 days
// without use, and deactivating or deleting an account still ends its session on the next request.
const MINUTE = 60 * 1000, HOUR = 60 * MINUTE, DAY = 24 * HOUR, WEEK = 7 * DAY;
const NOW = Date.parse('2026-10-19T15:00:00.000Z');
const COOKIE = /^egc_hub_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800$/;
const pair = setCookie => setCookie.split(';')[0];
const claims = setCookie => JSON.parse(Buffer.from(pair(setCookie).split('=')[1].split('.')[0], 'base64url').toString('utf8'));
const withCookie = (cookie, path = '/api/hub-auth', init = {}) => new Request(`${ORIGIN}${path}`, { ...init, headers: { ...(init.headers || {}), ...(cookie ? { Cookie: cookie } : {}) } });
const renew = (env, cookie, at) => renewHubSessionCookie(withCookie(cookie), env, at);
const session = (env, cookie, at) => verifyHubSessionToken(env, pair(cookie).split('=')[1], at);

test('a staff session lasts 7 days from issue and comes back with a fresh 7 days once it is an hour old', async () => {
  const env = staffEnv();
  const first = await createHubSessionCookie(env, 'TylerG', null, NOW);
  assert.match(first, COOKIE);
  assert.equal(claims(first).exp, NOW + WEEK);
  assert.equal((await session(env, first, NOW + WEEK - 1)).user, 'TylerG', 'valid one millisecond before 7 days');
  assert.equal(await session(env, first, NOW + WEEK), null, 'over at 7 days');
  assert.equal(await renew(env, pair(first), NOW + 59 * MINUTE), '', 'a session under an hour old is left as it is');
  const renewed = await renew(env, pair(first), NOW + 61 * MINUTE);
  assert.match(renewed, COOKIE);
  assert.deepEqual([claims(renewed).v, claims(renewed).u, claims(renewed).exp], [1, 'TylerG', NOW + 61 * MINUTE + WEEK]);
  assert.equal((await session(env, renewed, NOW + 61 * MINUTE + WEEK - 1)).user, 'TylerG');

  // Used every six days for six weeks, the sign-in never ends; then a week without use ends it.
  let cookie = pair(first), at = NOW;
  for (let use = 1; use <= 7; use++) {
    at += 6 * DAY;
    assert.equal((await session(env, cookie, at))?.user, 'TylerG', `still signed in at use ${use}`);
    cookie = pair(await renew(env, cookie, at));
  }
  at += WEEK;
  assert.equal(await session(env, cookie, at), null, '7 days without use ends the session');
  assert.equal(await renew(env, cookie, at), '', 'an ended session is never renewed');

  // A session with 12 hours left is renewed to 7 days on its next request, and keeps its sign-in's id.
  const late = `egc_hub_session=${await createHubSessionToken(env, 'TylerG', NOW - WEEK + 12 * HOUR)}`;
  assert.equal(claims(late).exp, NOW + 12 * HOUR);
  assert.equal(claims(await renew(env, late, NOW)).exp, NOW + WEEK);
  assert.equal(claims(await renew(env, late, NOW)).s, claims(late).s);
});

// A token signed as the code before STAFF-SESSION signed it: a configured account's payload had no credential version.
const signed = (env, body) => `egc_hub_session=${Buffer.from(JSON.stringify(body)).toString('base64url')}.${createHmac('sha256', env.HUB_SESSION_SECRET).update(Buffer.from(JSON.stringify(body)).toString('base64url')).digest('base64url')}`;

test('changing a configured owner or manager password in HUB_AUTH_USERS_JSON ends that account\'s sessions, renewed or not', async () => {
  const usersWith = async password => JSON.stringify({ ZacB: { passwordHash: await hashHubCredential('ZacB', password), role: 'owner', displayName: 'Synthetic Owner' } });
  const env = { HUB_SESSION_SECRET: 'synthetic-password-change-secret', HUB_AUTH_USERS_JSON: await usersWith('old synthetic password') };
  const changed = { ...env, HUB_AUTH_USERS_JSON: await usersWith('new synthetic password') };
  const first = pair(await createHubSessionCookie(env, 'ZacB', null, NOW - 2 * HOUR));
  // The credential version is keyed with the session secret: the cookie never holds the hash or anything a guess can test.
  const { pv } = claims(first), record = JSON.parse(env.HUB_AUTH_USERS_JSON).ZacB.passwordHash;
  assert.match(pv, /^[A-Za-z0-9_-]{16}$/);
  assert.equal(pair(first).includes(record) || pv === createHash('sha256').update(record).digest('hex').slice(0, 16), false);
  const renewed = pair(await renew(env, first, NOW));
  assert.equal((await session(env, renewed, NOW + DAY)).user, 'ZacB', 'unchanged, the owner stays signed in');
  for (const [label, value] of [['the first sign-in', first], ['a renewed one', renewed]]) {
    assert.equal(await session(changed, value, NOW + MINUTE), null, `${label} ends with the password change`);
    assert.equal(await renew(changed, value, NOW + 2 * HOUR), '', `${label} is never renewed after it`);
  }
  // Used every five days for a month after the change, the old cookie never works again; a new sign-in does.
  for (let day = 5; day <= 30; day += 5) assert.equal(await session(changed, renewed, NOW + day * DAY), null, `day ${day}`);
  assert.equal((await session(changed, pair(await createHubSessionCookie(changed, 'ZacB', null, NOW)), NOW + MINUTE)).user, 'ZacB');

  // A session issued before the credential version is accepted until its own 12-hour expiry but never renewed.
  const legacy = signed(env, { v: 1, u: 'ZacB', exp: NOW + 10 * HOUR });
  assert.equal((await session(env, legacy, NOW)).user, 'ZacB');
  assert.equal(await renew(env, legacy, NOW), '', 'never renewed');
  assert.equal(await session(env, legacy, NOW + 10 * HOUR), null, 'ends at its own expiry');
  // A forged credential version is refused like any other edit.
  assert.equal(await session(env, signed({ HUB_SESSION_SECRET: 'synthetic-other' }, { v: 1, u: 'ZacB', pv, exp: NOW + DAY }), NOW), null);
});

test('each sign-in has its own id that every renewal keeps', async () => {
  const env = staffEnv();
  const one = pair(await createHubSessionCookie(env, 'ZacB', null, NOW - 2 * HOUR)), two = pair(await createHubSessionCookie(env, 'ZacB', null, NOW - 2 * HOUR));
  assert.match(claims(one).s, /^[A-Za-z0-9_-]{16}$/);
  assert.notEqual(claims(one).s, claims(two).s, 'another sign-in, another id');
  let cookie = one;
  for (let use = 1; use <= 3; use++) cookie = pair(await renew(env, cookie, NOW + use * DAY));
  assert.deepEqual([claims(cookie).s, claims(cookie).exp], [claims(one).s, NOW + 3 * DAY + WEEK]);
  assert.equal(hubSessionIdentity(withCookie(cookie)), hubSessionIdentity(withCookie(one)), 'the identity a flow binds to survives renewals');
  assert.notEqual(hubSessionIdentity(withCookie(two)), hubSessionIdentity(withCookie(one)));
  assert.equal(hubSessionIdentity(withCookie('')), '');
});

test('Gusto connects through the edge while the session renews: on the start, from another tab, and never for another sign-in', async t => {
  const COMPANY = '11111111-1111-4111-8111-111111111111', endpoint = 'https://easygaragecleaning.com/api/gusto-auth';
  const env = {
    GUSTO_ENVIRONMENT: 'demo', GUSTO_COMPANY_UUID: COMPANY, GUSTO_CLIENT_ID: 'synthetic-client-id', GUSTO_CLIENT_SECRET: 'synthetic-client-secret', GUSTO_REDIRECT_URI: endpoint,
    FIREBASE_API_KEY: 'firebase-test-gusto-auth', EMPLOYEE_HUB_DATA_SECRET: 'synthetic-gusto-vault-secret', HUB_SESSION_SECRET: 'synthetic-gusto-session-secret',
    HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'synthetic-owner-hash', role: 'owner' } }),
  };
  const docs = new Map();
  let revision = 0;
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input);
    if (url.hostname === 'firestore.googleapis.com') {
      const id = url.pathname.split('/').pop();
      if ((options.method || 'GET') === 'PATCH') docs.set(id, { ...JSON.parse(options.body), updateTime: `2026-10-19T12:00:00.${String(++revision).padStart(9, '0')}Z` });
      return docs.has(id) ? Response.json(docs.get(id)) : Response.json({}, { status: 404 });
    }
    if (url.pathname === '/oauth/token') return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_in: 7200 });
    if (url.pathname === '/v1/token_info') return Response.json({ resource: { type: 'Company', uuid: COMPANY }, resource_owner: { type: 'CompanyAdmin', uuid: '22222222-2222-4222-8222-222222222222' } });
    return Response.json([]);
  });
  await writeGustoRecord(env, 'oauth-tokens', { state: 'connected', accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + 2 * HOUR, connectedAt: '2026-10-01T00:00:00Z' }, null);
  const edge = (request, handler) => middleware({ env, request, next: () => handler({ env, request }) });
  // The browser keeps whatever session cookie the last response gave it.
  const browser = cookie => ({ cookie, take(response) { const renewed = response.headers.getSetCookie().find(line => line.startsWith('egc_hub_session=')); if (renewed) this.cookie = pair(renewed); return response; } });
  const begin = async tab => {
    const started = tab.take(await edge(new Request(endpoint, { headers: { Cookie: tab.cookie, 'Sec-Fetch-Site': 'same-origin' } }), gustoAuth.onRequestGet));
    assert.equal(started.status, 302);
    return { state: new URL(started.headers.get('Location')).searchParams.get('state'), oauth: pair(started.headers.getSetCookie().find(line => line.startsWith('egc_gusto_oauth='))) };
  };
  const complete = async (cookie, { state, oauth }) => (await edge(new Request(endpoint, { method: 'POST', headers: { Cookie: `${cookie}; ${oauth}`, Origin: 'https://easygaragecleaning.com', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: 'synthetic-code', state }) }), gustoAuth.onRequestPost)).headers.get('Location');

  // A session issued two hours ago is renewed on the Connect Gusto response itself.
  const owner = browser(pair(await createHubSessionCookie(env, 'ZacB', null, Date.now() - 2 * HOUR))), before = owner.cookie;
  const flow = await begin(owner);
  assert.notEqual(owner.cookie, before, 'the start response renewed the session');
  assert.equal(await complete(owner.cookie, flow), '/employee?view=timesheets&gusto=connected');

  // A session 55 minutes old starts the flow; another Hub tab's request renews it while the owner is at Gusto.
  const tab = browser(pair(await createHubSessionCookie(env, 'ZacB', null, Date.now() - 55 * MINUTE)));
  const second = await begin(tab);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 8 * MINUTE });
  const other = tab.cookie;
  tab.take(await edge(withCookie(tab.cookie), hubAuth.onRequestGet));
  assert.notEqual(tab.cookie, other, 'the other tab renewed the session');
  // Another sign-in of the same owner (another device) cannot finish it; the renewed session can.
  const elsewhere = pair(await createHubSessionCookie(env, 'ZacB'));
  assert.equal(await complete(elsewhere, second), '/employee?view=timesheets&gusto=invalid-state');
  assert.equal(await complete(tab.cookie, second), '/employee?view=timesheets&gusto=connected');
  assert.equal(await complete(tab.cookie, second), '/employee?view=timesheets&gusto=invalid-state', 'and the state is used once');
});

test('a renewal is checked like any request: forged, expired, removed or unsigned sessions get nothing', async () => {
  const env = staffEnv(), cookie = pair(await createHubSessionCookie(env, 'Crew.Static', null, NOW - 2 * HOUR));
  assert.match(await renew(env, cookie, NOW), COOKIE);
  const [name, token] = cookie.split('='), [payload, signature] = token.split('.');
  const body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const forge = changes => `${name}=${Buffer.from(JSON.stringify({ ...body, ...changes })).toString('base64url')}.${signature}`;
  const refused = [
    ['another user', forge({ u: 'ZacB' })], ['a longer expiry', forge({ exp: body.exp + DAY })], ['a later expiry inside the window', forge({ exp: body.exp + MINUTE })],
    ['a flipped signature', `${name}=${payload}.${signature.slice(0, -1)}${signature.at(-1) === 'A' ? 'B' : 'A'}`], ['garbage', `${name}=not-a-session`], ['no cookie', ''],
    ['another secret', pair(await createHubSessionCookie({ ...env, HUB_SESSION_SECRET: 'synthetic-other-session-secret' }, 'Crew.Static', null, NOW - 2 * HOUR))],
  ];
  for (const [label, value] of refused) assert.equal(await renew(env, value, NOW), '', label);
  assert.equal(await renew({ ...env, HUB_SESSION_SECRET: '' }, cookie, NOW), '', 'no session secret');
  const removed = { ...env, HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'unused-synthetic-owner-hash', role: 'owner' } }) };
  assert.equal(await renew(removed, cookie, NOW), '', 'an account removed from the Hub configuration is not renewed');
  assert.equal(await session(removed, cookie, NOW), null, 'and its session ends on that request');
});

test('an employee account is renewed only while approved: rejecting or deleting it in the Hub ends its session on the next request', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const fire = vaultFirestore(t), env = staffEnv();
  const before = new Set(fire.documents.keys());
  await seedAccount(env, 'Rep.Knock');
  const accountKeys = [...fire.documents.keys()].filter(key => !before.has(key));
  await seedAccount(env, 'Rep.Gone');
  const goneKeys = [...fire.documents.keys()].filter(key => !before.has(key) && !accountKeys.includes(key));
  const { cookie } = await login(env, 'Rep.Knock'), gone = (await login(env, 'Rep.Gone')).cookie;
  assert.deepEqual([claims(cookie).v, claims(cookie).exp], [2, NOW + WEEK]);

  t.mock.timers.tick(2 * HOUR);
  const renewed = await renewHubSessionCookie(withCookie(cookie), env);
  assert.match(renewed, COOKIE);
  assert.deepEqual([claims(renewed).v, claims(renewed).u, claims(renewed).av, claims(renewed).exp], [2, 'Rep.Knock', claims(cookie).av, NOW + 2 * HOUR + WEEK]);
  assert.equal((await getHubSession(withCookie(pair(renewed)), env)).user, 'Rep.Knock');
  const reads = fire.requests.length;
  t.mock.timers.tick(10 * MINUTE);
  assert.equal(await renewHubSessionCookie(withCookie(pair(renewed)), env), '');
  assert.equal(fire.requests.length, reads, 'a session under an hour old is never checked against storage for a renewal');

  // The owner rejects the account in the Hub (the staff account review).
  const owner = await cookieFor(env, 'ZacB');
  const review = await employeeAccountsHandlers({ now: () => new Date() }).post({ env, request: jsonRequest('/api/employee-accounts', { action: 'review', username: 'Rep.Knock', decision: 'rejected' }, owner) });
  assert.equal(review.status, 200, await review.clone().text());
  for (const value of [cookie, pair(renewed)]) {
    assert.equal(await getHubSession(withCookie(value), env), null, 'the session ends with the change');
    assert.equal(await renewHubSessionCookie(withCookie(value), env), '', 'and is never renewed');
  }
  t.mock.timers.tick(2 * HOUR);
  const refused = await middleware({ env, request: withCookie(pair(renewed)), next: () => hubAuth.onRequestGet({ env, request: withCookie(pair(renewed)) }) });
  assert.equal(refused.status, 401);
  assert.deepEqual(refused.headers.getSetCookie(), [], 'an ended session gets no cookie back');

  // An account deleted from storage ends the same way.
  assert.match(await renewHubSessionCookie(withCookie(gone), env), COOKIE);
  for (const key of goneKeys) fire.documents.delete(key);
  assert.equal(await getHubSession(withCookie(gone), env), null);
  assert.equal(await renewHubSessionCookie(withCookie(gone), env), '');
});

test('the edge renews a staff session on API requests only, never over a sign-in or sign-out cookie', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const env = { HUB_SESSION_SECRET: 'synthetic-renewal-session-secret', HUB_AUTH_USERS_JSON: JSON.stringify({ Tester: await hashHubCredential('Tester', 'correct horse') }) };
  const old = pair(await createHubSessionCookie(env, 'Tester', null, NOW - 2 * HOUR)), fresh = pair(await createHubSessionCookie(env, 'Tester', null, NOW - 10 * MINUTE));
  const edge = (request, handler) => middleware({ env, request, next: () => handler({ env, request }) });

  const check = await edge(withCookie(old), hubAuth.onRequestGet);
  assert.equal(check.status, 200);
  assert.equal(check.headers.get('cache-control'), 'no-store');
  const [renewed, ...more] = check.headers.getSetCookie();
  assert.deepEqual(more, []);
  assert.match(renewed, COOKIE);
  assert.equal(claims(renewed).exp, NOW + WEEK);
  assert.deepEqual((await edge(withCookie(fresh), hubAuth.onRequestGet)).headers.getSetCookie(), [], 'a session under an hour old gets no new cookie');
  // Any API answer renews it, even one the handler refuses for another reason.
  const other = await edge(withCookie(old, '/api/knock-me'), () => Response.json({ ok: false }, { status: 403 }));
  assert.match(other.headers.getSetCookie()[0], COOKIE);

  // Sign-out clears the cookie; the renewal never puts it back.
  const signOut = await edge(withCookie(old, '/api/hub-auth', { method: 'DELETE', headers: { Origin: ORIGIN } }), ({ request }) => hubAuth.onRequestDelete({ request }));
  assert.deepEqual(signOut.headers.getSetCookie().map(line => line.split(';').find(part => part.includes('Max-Age'))?.trim()), ['Max-Age=0']);
  // Sign-in issues its own cookie; the renewal adds none.
  const signIn = await edge(withCookie(old, '/api/hub-auth', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Tester', password: 'correct horse' }) }), hubAuth.onRequestPost);
  assert.equal(signIn.status, 200);
  assert.equal(signIn.headers.getSetCookie().length, 1);
  assert.equal(claims(signIn.headers.getSetCookie()[0]).exp, NOW + WEEK);

  // Pages and files are never given a cookie (they may be cached); the next API call renews the session.
  for (const path of ['/crew/knock', '/crew/', '/employee', '/crew/knock-app.js']) {
    const page = await middleware({ env, request: withCookie(old, path, { headers: { Accept: 'text/html' } }), next: async () => new Response('static body', { headers: { 'Content-Type': 'text/html' } }) });
    assert.deepEqual(page.headers.getSetCookie(), [], path);
  }
  // A renewal whose check fails (here a broken staff configuration) leaves the API answer as it was.
  const broken = await middleware({ env: { ...env, HUB_AUTH_USERS_JSON: '{not json' }, request: withCookie(old), next: async () => Response.json({ ok: true }) });
  assert.equal(broken.status, 200);
  assert.deepEqual(broken.headers.getSetCookie(), []);
});

test('Knock keeps its offline copy of who is signed in exactly as long as an unused Hub session lasts', async () => {
  const knock = readFileSync(new URL('../crew/knock-app.js', import.meta.url), 'utf8');
  const hours = /const SESSION_HOURS = (\d+) \* (\d+);/.exec(knock).slice(1).reduce((a, b) => Number(a) * Number(b));
  const maxAge = Number(/Max-Age=(\d+)/.exec(await createHubSessionCookie(staffEnv(), 'Crew.Static', null, NOW))[1]);
  assert.deepEqual([hours * 60 * 60, hours], [maxAge, 7 * 24]);
  // Knock refreshes that copy whenever the phone reaches the server signed in, as the server renews the session.
  assert.match(knock, /remember\(VIEWER_KEY, \{ \.\.\.S\.viewer, savedAt: Date\.now\(\) \}\);\n  await saveMe\(\);/);
});
