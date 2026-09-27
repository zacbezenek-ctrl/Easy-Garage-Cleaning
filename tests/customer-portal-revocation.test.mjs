import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import {
  createCustomerPortalAccessToken, createCustomerPortalCollaboratorAccessToken, createCustomerPortalSessionCookie, createCustomerPortalSessionToken,
  customerPortalLinkVersion, verifyCustomerPortalAccessToken, verifyCustomerPortalSessionToken,
} from '../functions/_lib/customer-portal.js';
import { readCustomerPortalContext } from '../functions/_lib/customer-portal-access.js';
import { revokeCustomerPortalLinks } from '../functions/_lib/customer-portal-revocation.js';
import { sendAcceptedQuotePortal } from '../functions/_lib/portal-invitation.js';
import { decodeFirestoreFields, encodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import { customerPortalRevokeHandlers } from '../functions/api/customer-portal-revoke.js';
import { customerPortalLinkHandler } from '../functions/api/customer-portal-link.js';
import { customerPortalSessionHandler } from '../functions/api/customer-portal-session.js';
import * as portal from '../functions/api/customer-portal.js';

const NOW = Date.parse('2026-09-22T12:00:00.000Z');
const origin = 'https://easygaragecleaning.com';
const env = {
  HUB_SESSION_SECRET: 'synthetic-revocation-hub-secret', CUSTOMER_PORTAL_SECRET: 'synthetic-revocation-portal-secret',
  FIREBASE_API_KEY: 'firebase-test-portal-revocation', HIGHLEVEL_API_KEY: 'synthetic-highlevel-key', HIGHLEVEL_LOCATION_ID: 'location-1',
  HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'synthetic-hash', role: 'owner' }, FrankJara: { passwordHash: 'synthetic-hash', role: 'crew' } }),
};
const permissions = { view: true, decide: true, pay: true, rebook: true };
const person = (changes = {}) => ({ id: 'person-1', name: 'Synthetic Person', email: 'person@example.invalid', status: 'active', permissions: { ...permissions }, ...changes });
const baseJob = (changes = {}) => ({ type: 'job', customer: 'Synthetic Customer', customerId: 'customer-1', address: '100 Synthetic Street', total: 400, customerCollaborators: [person()], ...changes });
const manager = { user: 'zacb', role: 'owner', businessAccess: true };

// Firestore REST emulator: versioned documents, patch/commit preconditions
// (412 on mismatch) and HighLevel stubs. Any other host fails the test.
function firestore(t, seed = {}) {
  const documents = new Map(), calls = [], messages = [];
  let counter = 0;
  const put = (path, data) => documents.set(path, { data: structuredClone(data), updateTime: `2026-09-22T12:00:00.${String(++counter).padStart(6, '0')}Z` });
  for (const [id, data] of Object.entries(seed)) put(`jobs/${id}`, data);
  const body = path => ({ name: `projects/egcw-1ec83/databases/(default)/documents/${path}`, fields: encodeFirestoreFields(documents.get(path).data), updateTime: documents.get(path).updateTime });
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    calls.push({ url, method, body: options.body });
    if (url.hostname === 'services.leadconnectorhq.com') {
      if (url.pathname === '/contacts/contact-1') return Response.json({ contact: { id: 'contact-1', locationId: 'location-1', phone: '+19705550123', email: 'synthetic@example.invalid', dnd: false } });
      if (url.pathname === '/conversations/messages') { messages.push(JSON.parse(options.body)); return Response.json({ messageId: 'message-1', conversationId: 'conversation-1' }); }
      throw new Error(`Unexpected synthetic HighLevel request: ${url.pathname}`);
    }
    assert.equal(url.hostname, 'firestore.googleapis.com');
    const path = decodeURIComponent(url.pathname.split('/documents')[1] || '').replace(/^\//, '');
    if (path === ':commit') {
      const writes = JSON.parse(options.body).writes, keys = writes.map(write => write.update.name.split('/documents/')[1]);
      assert.equal(new Set(keys).size, keys.length, 'a commit never writes one document twice');
      for (const [index, write] of writes.entries()) {
        const existing = documents.get(keys[index]);
        if (write.currentDocument?.exists === false ? existing : write.currentDocument?.updateTime !== existing?.updateTime) return Response.json({}, { status: 412 });
      }
      for (const [index, write] of writes.entries()) put(keys[index], { ...(documents.get(keys[index])?.data || {}), ...decodeFirestoreFields(write.update.fields) });
      return Response.json({ commitTime: '2026-09-22T12:00:00Z' });
    }
    if (method === 'PATCH') {
      const existing = documents.get(path), expected = url.searchParams.get('currentDocument.updateTime');
      if (expected ? existing?.updateTime !== expected : url.searchParams.get('currentDocument.exists') === 'false' && existing) return Response.json({}, { status: 412 });
      const patch = decodeFirestoreFields(JSON.parse(options.body).fields);
      put(path, url.searchParams.getAll('updateMask.fieldPaths').length ? { ...(existing?.data || {}), ...patch } : patch);
      return Response.json(body(path));
    }
    assert.equal(method, 'GET');
    return documents.has(path) ? Response.json(body(path)) : Response.json({}, { status: 404 });
  });
  return {
    documents, calls, messages,
    job: id => documents.get(`jobs/${id}`)?.data,
    revision: id => documents.get(`jobs/${id}`)?.updateTime,
    edit: (id, patch) => put(`jobs/${id}`, { ...documents.get(`jobs/${id}`).data, ...patch }),
    writes: () => calls.filter(call => call.method === 'PATCH' || call.url.pathname.endsWith(':commit')).length,
  };
}

const hubCookie = async user => (await createHubSessionCookie(env, user)).split(';')[0];
const staffRequest = (path, cookie, body, headers = {}) => new Request(origin + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', ...headers },
  ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
});
const accessOf = url => new URL(url).searchParams.get('access');
const exchange = access => customerPortalSessionHandler({ now: () => new Date(NOW) })({ env, request: new Request(`${origin}/api/customer-portal-session?access=${encodeURIComponent(access)}`) });
const cookieOf = response => response.headers.get('set-cookie')?.split(';')[0] || '';
const portalGet = cookie => portal.onRequestGet({ env, request: new Request(`${origin}/api/customer-portal`, { headers: { Origin: origin, Cookie: cookie } }) });
const portalPost = (cookie, body) => portal.onRequestPost({ env, request: new Request(`${origin}/api/customer-portal`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });

async function signedPayload(purpose, claims) {
  const encoder = new TextEncoder(), payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const key = await crypto.subtle.importKey('raw', encoder.encode(`${env.CUSTOMER_PORTAL_SECRET}:customer-portal:${purpose}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `${payload}.${Buffer.from(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))).toString('base64url')}`;
}

const DAY = 24 * 60 * 60 * 1000;
// Tokens minted before link versions existed: validly signed, no lv/lr claims.
const legacyToken = (purpose, claims = {}) => signedPayload(purpose, { v: 1, j: 'job-1', exp: NOW + DAY, ...claims });
const sessionClaims = cookie => verifyCustomerPortalSessionToken(env, cookie.split(';')[0].split('=')[1], NOW);

test('access and session tokens carry a signed link version and account root', async () => {
  const legacy = await verifyCustomerPortalAccessToken(env, await legacyToken('access'), NOW);
  assert.equal(legacy.jobId, 'job-1');
  assert.equal('linkVersion' in legacy, false, 'links minted without a version keep their original shape');
  assert.equal('linkRoot' in legacy, false);
  const bound = await verifyCustomerPortalAccessToken(env, await createCustomerPortalAccessToken(env, 'job-1', NOW, 2, 'root-1'), NOW);
  assert.deepEqual([bound.linkVersion, bound.linkRoot], [2, 'root-1']);
  assert.equal((await verifyCustomerPortalAccessToken(env, await createCustomerPortalAccessToken(env, 'job-1', NOW, 0), NOW)).linkVersion, 0);
  const session = await verifyCustomerPortalSessionToken(env, await createCustomerPortalSessionToken(env, 'job-1', NOW, { linkVersion: 4, linkRoot: 'job-1' }), NOW);
  assert.deepEqual([session.linkVersion, session.linkRoot], [4, 'job-1']);
  const collaborator = await verifyCustomerPortalAccessToken(env, await createCustomerPortalCollaboratorAccessToken(env, 'job-1', 'person-1', permissions, NOW, 3, 'root-1'), NOW);
  assert.deepEqual([collaborator.actorId, collaborator.linkVersion, collaborator.linkRoot], ['person-1', 3, 'root-1']);
  for (const linkVersion of [-1, 1.5, '1', Number.NaN, null]) {
    await assert.rejects(() => createCustomerPortalAccessToken(env, 'job-1', NOW, linkVersion), /link version/);
  }
  for (const linkRoot of ['', 'secure_vault', '_egc_schedule_lock', '../root', 'x'.repeat(181), 7, null]) {
    await assert.rejects(() => createCustomerPortalAccessToken(env, 'job-1', NOW, 0, linkRoot), /account root/, JSON.stringify(linkRoot));
  }
  // A signature cannot launder a malformed claim into "no claim".
  for (const lv of [-1, 1.5, '2', null, true]) {
    assert.equal(await verifyCustomerPortalAccessToken(env, await legacyToken('access', { lv }), NOW), null, JSON.stringify(lv));
  }
  for (const lr of ['', 'secure_vault', '../root', 5, null, ['job-1']]) {
    assert.equal(await verifyCustomerPortalAccessToken(env, await legacyToken('access', { lv: 0, lr }), NOW), null, JSON.stringify(lr));
  }
  assert.equal((await verifyCustomerPortalAccessToken(env, await legacyToken('access', { lv: 7 }), NOW)).linkVersion, 7);
  const tampered = (await createCustomerPortalAccessToken(env, 'job-1', NOW, 1, 'job-1')).split('.');
  for (const change of [{ lv: 9 }, { lr: 'another-root' }]) {
    const raised = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(tampered[0], 'base64url')), ...change })).toString('base64url');
    assert.equal(await verifyCustomerPortalAccessToken(env, `${raised}.${tampered[1]}`, NOW), null, JSON.stringify(change));
  }
  assert.deepEqual([undefined, null, 0, 3, -1, '2', 1.5].map(value => customerPortalLinkVersion({ customerPortalLinkVersion: value })), [0, 0, 0, 3, null, null, null]);
});

test('minting an owner token or session without a link version is a programmer error', async () => {
  // Defaulting to version 0 would lock the owner out after the first revocation.
  const missing = { name: 'TypeError', message: /explicit linkVersion/ };
  await assert.rejects(() => createCustomerPortalSessionCookie(env, 'job-1', {}, NOW), missing);
  await assert.rejects(() => createCustomerPortalSessionCookie(env, 'job-1'), missing);
  await assert.rejects(() => createCustomerPortalSessionCookie(env, 'job-1', { permissions, linkVersion: undefined, linkRoot: 'job-1' }, NOW), missing);
  await assert.rejects(() => createCustomerPortalSessionToken(env, 'job-1', NOW), missing);
  await assert.rejects(() => createCustomerPortalAccessToken(env, 'job-1', NOW), missing);
  await assert.rejects(() => createCustomerPortalAccessToken(env, 'job-1', NOW, undefined, 'job-1'), missing);
  await assert.rejects(() => createCustomerPortalCollaboratorAccessToken(env, 'job-1', '!!!', permissions, NOW), missing, 'an actor id that sanitizes to nothing mints an owner token');
  assert.equal((await sessionClaims(await createCustomerPortalSessionCookie(env, 'job-1', { linkVersion: 0 }, NOW))).linkVersion, 0);
  // Collaborator and business-project tokens are rechecked against saved
  // records on every request, so they may still omit the version.
  assert.equal((await sessionClaims(await createCustomerPortalSessionCookie(env, 'job-1', { actorId: 'biz_synthetic', permissions }, NOW))).actorId, 'biz_synthetic');
  assert.equal('linkVersion' in await verifyCustomerPortalAccessToken(env, await createCustomerPortalCollaboratorAccessToken(env, 'job-1', 'person-1', permissions, NOW), NOW), false);
});

test('owner links without a version keep working until the first revocation', async () => {
  const jobs = new Map([['job-1', { id: 'job-1', ...baseJob() }]]), read = async (_env, id) => jobs.get(id) || null;
  const context = await readCustomerPortalContext(env, { jobId: 'job-1' }, { read });
  assert.equal(context.linkVersion, 0);
  assert.equal(context.session.linkVersion, 0, 'an exchanged session is bound to the version current at exchange');
  assert.equal((await readCustomerPortalContext(env, { jobId: 'job-1', linkVersion: 0 }, { read })).linkVersion, 0);
  jobs.get('job-1').customerPortalLinkVersion = 1;
  for (const session of [{ jobId: 'job-1' }, { jobId: 'job-1', linkVersion: 0 }]) {
    await assert.rejects(() => readCustomerPortalContext(env, session, { read }), error => error.status === 403 && error.code === 'CUSTOMER_PORTAL_ACCESS_REVOKED' && /replaced/.test(error.message));
  }
  assert.equal((await readCustomerPortalContext(env, { jobId: 'job-1', linkVersion: 1 }, { read })).session.linkVersion, 1);
  assert.equal((await readCustomerPortalContext(env, { jobId: 'job-1', linkVersion: 2 }, { read })).linkVersion, 1);
  for (const malformed of ['1', -1, 1.5, { value: 1 }]) {
    jobs.get('job-1').customerPortalLinkVersion = malformed;
    await assert.rejects(() => readCustomerPortalContext(env, { jobId: 'job-1', linkVersion: 99 }, { read }), error => error.status === 403 && error.code === 'CUSTOMER_PORTAL_ACCOUNT_INVALID', 'a malformed version is never read as zero');
  }
});

test('the verified account root version governs every job in the account', async () => {
  const jobs = new Map([
    ['job-1', { id: 'job-1', ...baseJob({ customerAccountOwnerJobId: 'root', customerPortalLinkVersion: 0, customerCollaborators: [] }) }],
    ['root', { id: 'root', ...baseJob({ customerPortalLinkVersion: 2 }) }],
  ]), read = async (_env, id) => jobs.get(id) || null;
  await assert.rejects(() => readCustomerPortalContext(env, { jobId: 'job-1' }, { read }), { code: 'CUSTOMER_PORTAL_ACCESS_REVOKED' });
  await assert.rejects(() => readCustomerPortalContext(env, { jobId: 'job-1', linkVersion: 1 }, { read }), { code: 'CUSTOMER_PORTAL_ACCESS_REVOKED' });
  const context = await readCustomerPortalContext(env, { jobId: 'job-1', linkVersion: 2 }, { read });
  assert.deepEqual([context.accountJobId, context.linkVersion], ['root', 2]);
  jobs.get('job-1').customerPortalLinkVersion = 9;
  assert.equal((await readCustomerPortalContext(env, { jobId: 'job-1', linkVersion: 2 }, { read })).linkVersion, 2, 'a copied child value never replaces the account version');
});

test('root-bound tokens stop working when their job moves to another account root', async () => {
  const jobs = new Map([
    ['job-1', { id: 'job-1', ...baseJob() }],
    ['root-b', { id: 'root-b', ...baseJob() }],
  ]), read = async (_env, id) => jobs.get(id) || null;
  const owner = { jobId: 'job-1', linkVersion: 0, linkRoot: 'job-1' }, invited = { jobId: 'job-1', actorId: 'person-1', permissions, linkRoot: 'job-1' };
  const context = await readCustomerPortalContext(env, owner, { read });
  assert.deepEqual([context.accountJobId, context.linkRoot, context.linkVersion], ['job-1', 'job-1', 0]);
  assert.equal((await readCustomerPortalContext(env, invited, { read })).session.actorId, 'person-1');
  jobs.get('job-1').customerAccountOwnerJobId = 'root-b';
  // Both roots are at version 0 and list person-1, so only the root claim differs.
  for (const session of [owner, invited]) {
    await assert.rejects(() => readCustomerPortalContext(env, session, { read }), error => error.status === 403 && error.code === 'CUSTOMER_PORTAL_ACCESS_REVOKED', JSON.stringify(session));
  }
  const unbound = await readCustomerPortalContext(env, { jobId: 'job-1', linkVersion: 0 }, { read });
  assert.equal(unbound.accountJobId, 'root-b', 'tokens without a root claim keep today’s behavior');
  assert.equal((await readCustomerPortalContext(env, { ...invited, linkRoot: undefined }, { read })).session.actorId, 'person-1');
  assert.equal((await readCustomerPortalContext(env, { ...owner, linkRoot: 'root-b' }, { read })).linkRoot, 'root-b');
});

test('collaborator revocation is unchanged by homeowner link versions', async () => {
  const jobs = new Map([['job-1', { id: 'job-1', ...baseJob({ customerPortalLinkVersion: 3 }) }]]), read = async (_env, id) => jobs.get(id) || null;
  const invited = { jobId: 'job-1', actorId: 'person-1', permissions };
  const context = await readCustomerPortalContext(env, invited, { read });
  assert.equal(context.session.actorId, 'person-1');
  assert.equal('linkVersion' in context.session, false, 'collaborator sessions keep only the version their invitation carried');
  jobs.get('job-1').customerCollaborators = [person({ permissions: { view: true, decide: false, pay: false, rebook: false } })];
  assert.deepEqual((await readCustomerPortalContext(env, invited, { read })).session.permissions, { view: true, decide: false, pay: false, rebook: false });
  for (const people of [[], [person({ status: 'removed' })], [person({ permissions: { view: false } })]]) {
    jobs.get('job-1').customerCollaborators = people;
    await assert.rejects(() => readCustomerPortalContext(env, invited, { read }), error => error.code === 'CUSTOMER_PORTAL_ACCESS_REVOKED' && /Ask the customer for a new invitation/.test(error.message));
  }
  jobs.get('job-1').customerCollaborators = [person()];
  await assert.rejects(() => readCustomerPortalContext(env, { ...invited, linkVersion: 2 }, { read }), { code: 'CUSTOMER_PORTAL_ACCESS_REVOKED' });
  assert.equal((await readCustomerPortalContext(env, { ...invited, linkVersion: 3 }, { read })).session.linkVersion, 3);
});

test('business project actors are unaffected by homeowner link versions', async () => {
  for (const version of [7, 'malformed']) {
    const job = { id: 'shared', __updateTime: 'v1', ...baseJob({ customerPortalLinkVersion: version }) };
    const context = await readCustomerPortalContext(env, { jobId: 'shared', actorId: 'biz_synthetic', permissions }, {
      read: async () => job, businessRead: async () => ({ name: 'Synthetic Business', permissions: { view: true, decide: false, pay: true, rebook: false } }),
    });
    assert.equal(context.session.actorId, 'biz_synthetic');
    assert.deepEqual(context.session.permissions, { view: true, decide: false, pay: true, rebook: false });
    assert.equal(context.linkVersion, undefined);
  }
});

test('staff revocation ends earlier links, sessions and authorized people while a fresh link works', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const f = firestore(t, { 'job-1': baseJob() }), zac = await hubCookie('ZacB');
  const linkApi = customerPortalLinkHandler({ now: () => new Date(NOW) }), revokeApi = customerPortalRevokeHandlers({ now: () => new Date(NOW) });
  const createLink = async () => { const response = await linkApi({ env, request: staffRequest('/api/customer-portal-link', zac, { job_id: 'job-1' }) }); assert.equal(response.status, 200); return accessOf((await response.json()).url); };

  const legacyAccess = await legacyToken('access');
  const legacySession = `egc_customer_portal=${await legacyToken('session')}`;
  const firstAccess = await createLink(), firstClaims = await verifyCustomerPortalAccessToken(env, firstAccess, NOW);
  assert.deepEqual([firstClaims.linkVersion, firstClaims.linkRoot], [0, 'job-1']);
  const metadataWrite = f.calls.find(call => call.method === 'PATCH' && call.url.pathname.endsWith('/jobs/job-1'));
  assert.ok(metadataWrite.url.searchParams.get('currentDocument.updateTime'), 'link metadata is written with a revision precondition');
  const sessions = [];
  for (const access of [legacyAccess, firstAccess]) {
    const response = await exchange(access);
    assert.equal(response.headers.get('location'), '/customer-portal');
    sessions.push(cookieOf(response));
    const claims = await sessionClaims(cookieOf(response));
    assert.deepEqual([claims.linkVersion, claims.linkRoot], [0, 'job-1'], 'even a legacy link exchanges into a version- and root-bound session');
  }
  const invite = await exchange(await createCustomerPortalCollaboratorAccessToken(env, 'job-1', 'person-1', permissions, NOW));
  const collaboratorSession = cookieOf(invite);
  for (const cookie of [legacySession, ...sessions, collaboratorSession]) assert.equal((await portalGet(cookie)).status, 200);

  const status = await revokeApi.get({ env, request: staffRequest('/api/customer-portal-revoke?jobId=job-1', zac) });
  assert.equal(status.status, 200);
  const before = await status.json();
  assert.deepEqual([before.accountJobId, before.linkVersion, before.revision, before.collaboratorCount], ['job-1', 0, f.revision('job-1'), 1]);
  const requestId = randomUUID();
  // The Hub omits clearCollaborators, which defaults to true.
  const revoked = await revokeApi.post({ env, request: staffRequest('/api/customer-portal-revoke', zac, { requestId, jobId: 'job-1', expectedRevision: before.revision }) });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.headers.get('Cache-Control'), 'no-store');
  const result = await revoked.json();
  assert.deepEqual([result.linkVersion, result.previousLinkVersion, result.accountJobId, result.revokedAt], [1, 0, 'job-1', new Date(NOW).toISOString()]);
  assert.deepEqual([result.clearCollaborators, result.removedCollaboratorCount], [true, 1]);
  assert.equal(f.job('job-1').customerPortalLinkVersion, 1);
  assert.deepEqual(f.job('job-1').customerCollaborators, [], 'authorized people are cleared in the same commit');
  assert.match(f.job('job-1').customerPortalLinksRevokedBy, /^zacb$/i);
  const receipt = f.documents.get(`customerPortalOperations/${requestId}`).data;
  assert.deepEqual([receipt.accountJobId, receipt.previousLinkVersion, receipt.linkVersion, receipt.clearCollaborators, receipt.removedCollaboratorCount], ['job-1', 0, 1, true, 1]);
  for (const secret of [firstAccess, 'person@example.invalid', 'Synthetic Person']) assert.equal(JSON.stringify(receipt).includes(secret), false);
  assert.equal(f.messages.length, 0, 'revocation never sends anything to the customer');

  for (const access of [legacyAccess, firstAccess]) {
    const response = await exchange(access);
    assert.equal(response.headers.get('location'), '/customer-portal?error=invalid');
    assert.equal(response.headers.has('set-cookie'), false);
  }
  const writes = f.writes();
  for (const cookie of [legacySession, ...sessions, collaboratorSession]) {
    const response = await portalGet(cookie);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'CUSTOMER_PORTAL_ACCESS_REVOKED');
    assert.equal((await portalPost(cookie, { action: 'save_customer_memory', parking_notes: 'Revoked write' })).status, 403);
  }
  assert.equal(f.writes(), writes, 'revoked sessions cannot write anything');

  const freshAccess = await createLink(), freshClaims = await verifyCustomerPortalAccessToken(env, freshAccess, NOW);
  assert.deepEqual([freshClaims.linkVersion, freshClaims.linkRoot], [1, 'job-1']);
  const fresh = await exchange(freshAccess);
  assert.equal(fresh.headers.get('location'), '/customer-portal');
  const view = await portalGet(cookieOf(fresh));
  assert.equal(view.status, 200);
  assert.equal((await view.json()).customer.name, 'Synthetic Customer');
});

test('a leaked owner link cannot keep access through an authorized person it added', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const f = firestore(t, { 'job-1': baseJob() }), zac = await hubCookie('ZacB');
  const link = await customerPortalLinkHandler({ now: () => new Date(NOW) })({ env, request: staffRequest('/api/customer-portal-link', zac, { job_id: 'job-1' }) });
  const leaked = accessOf((await link.json()).url);
  // The holder opens the leaked owner link, adds themselves next to the real
  // authorized person and mints an invitation for that new record.
  const ownerSession = cookieOf(await exchange(leaked));
  const intruder = { id: 'intruder-1', name: 'Synthetic Intruder', email: 'intruder@example.invalid', role: 'Friend', permissions: { decide: true, pay: true, rebook: true } };
  assert.equal((await portalPost(ownerSession, { action: 'save_collaborators', collaborators: [person(), intruder] })).status, 200);
  const minted = await portalPost(ownerSession, { action: 'create_collaborator_invite', person_id: 'intruder-1' });
  assert.equal(minted.status, 200);
  const invitation = accessOf((await minted.json()).url);
  assert.equal('linkVersion' in await verifyCustomerPortalAccessToken(env, invitation, NOW), false, 'today’s invitation path embeds no version (P4-01/P4-03 TODO)');
  const intruderSession = cookieOf(await exchange(invitation));
  assert.equal((await portalGet(intruderSession)).status, 200);

  const api = customerPortalRevokeHandlers({ now: () => new Date(NOW) });
  const status = await (await api.get({ env, request: staffRequest('/api/customer-portal-revoke?jobId=job-1', zac) })).json();
  assert.equal(status.collaboratorCount, 2);
  const requestId = randomUUID();
  const revoked = await api.post({ env, request: staffRequest('/api/customer-portal-revoke', zac, { requestId, jobId: 'job-1', expectedRevision: status.revision, clearCollaborators: true }) });
  assert.equal(revoked.status, 200);
  const result = await revoked.json();
  assert.deepEqual([result.linkVersion, result.clearCollaborators, result.removedCollaboratorCount], [1, true, 2]);
  assert.deepEqual(f.job('job-1').customerCollaborators, []);
  const receipt = f.documents.get(`customerPortalOperations/${requestId}`).data;
  assert.equal(receipt.removedCollaboratorCount, 2);
  for (const secret of ['intruder-1', 'Synthetic Intruder', 'intruder@example.invalid', 'person@example.invalid', 'Synthetic Person', invitation]) {
    assert.equal(JSON.stringify(receipt).includes(secret), false, 'receipts keep a count, never names or contacts');
  }

  const writes = f.writes();
  for (const cookie of [ownerSession, intruderSession]) {
    const response = await portalGet(cookie);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'CUSTOMER_PORTAL_ACCESS_REVOKED');
  }
  for (const access of [leaked, invitation]) assert.equal((await exchange(access)).headers.get('location'), '/customer-portal?error=invalid');
  assert.equal((await portalPost(intruderSession, { action: 'send_message', body: 'Still here?', request_id: randomUUID() })).status, 403);
  assert.equal((await portalPost(ownerSession, { action: 'save_collaborators', collaborators: [intruder] })).status, 403);
  assert.equal((await portalPost(ownerSession, { action: 'create_collaborator_invite', person_id: 'intruder-1' })).status, 403);
  assert.equal(f.writes(), writes, 'neither the leaked link nor its invitation can write anything');
  assert.deepEqual(f.job('job-1').customerCollaborators, []);
});

test('keeping authorized people still ends collaborator invitations that carry a link version', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const f = firestore(t, { 'job-1': baseJob() });
  // What P4-01/P4-03 should mint: the context's linkVersion and accountJobId.
  const versioned = await createCustomerPortalCollaboratorAccessToken(env, 'job-1', 'person-1', permissions, NOW, 0, 'job-1');
  const unversioned = await createCustomerPortalCollaboratorAccessToken(env, 'job-1', 'person-1', permissions, NOW);
  const versionedSession = cookieOf(await exchange(versioned));
  assert.deepEqual([(await sessionClaims(versionedSession)).linkVersion, (await sessionClaims(versionedSession)).actorId], [0, 'person-1']);
  assert.equal((await portalGet(versionedSession)).status, 200);
  const api = customerPortalRevokeHandlers({ session: async () => manager, now: () => new Date(NOW) });
  const revoked = await api.post({ env, request: staffRequest('/api/customer-portal-revoke', '', { requestId: randomUUID(), jobId: 'job-1', expectedRevision: f.revision('job-1'), clearCollaborators: false }) });
  const result = await revoked.json();
  assert.deepEqual([revoked.status, result.linkVersion, result.clearCollaborators, result.removedCollaboratorCount], [200, 1, false, 0]);
  assert.deepEqual(f.job('job-1').customerCollaborators.map(item => item.id), ['person-1'], 'the saved people are kept');
  assert.equal((await exchange(versioned)).headers.get('location'), '/customer-portal?error=invalid');
  const response = await portalGet(versionedSession);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'CUSTOMER_PORTAL_ACCESS_REVOKED');
  // An invitation minted without a version relies on the saved list alone,
  // which is why the Hub clears the list by default.
  assert.equal((await exchange(unversioned)).headers.get('location'), '/customer-portal');
});

test('revocation is manager-only, same-origin, bounded and requires the observed revision', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const f = firestore(t, { 'job-1': baseJob() });
  let actor = null;
  const api = customerPortalRevokeHandlers({ session: async () => actor, now: () => new Date(NOW) });
  const post = (body, headers = {}) => api.post({ env, request: staffRequest('/api/customer-portal-revoke', '', body, headers) });
  const get = query => api.get({ env, request: staffRequest(`/api/customer-portal-revoke${query}`, '') });
  const valid = () => ({ requestId: randomUUID(), jobId: 'job-1', expectedRevision: f.revision('job-1') });
  const code = async response => (await response.json()).code;

  assert.equal((await post(valid())).status, 401);
  assert.equal((await get('?jobId=job-1')).status, 401);
  for (const session of [{ user: 'frankjara', role: 'crew' }, { user: 'zacb', role: 'crew', businessAccess: true }, { user: 'frankjara', role: 'owner', businessAccess: true }]) {
    actor = session;
    const response = await post(valid());
    assert.equal(response.status, 403);
    assert.equal(await code(response), 'CUSTOMER_PORTAL_REVOKE_FORBIDDEN');
    assert.equal((await get('?jobId=job-1')).status, 403);
  }
  actor = manager;
  assert.equal((await post(valid(), { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post(valid(), { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await get('?jobId=job-1&jobId=job-2')).status, 400);
  assert.equal((await get('?jobId=job-1&extra=1')).status, 400);
  assert.equal((await get('?jobId=missing-job')).status, 404);
  assert.equal((await post(valid(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('x'.repeat(5000))).status, 413);
  assert.equal(await code(await post('{')), 'CUSTOMER_PORTAL_REVOKE_JSON_INVALID');
  // RegExp.test would coerce ['<uuid>'] to a string; every field is type-checked first.
  for (const body of [
    { ...valid(), extra: true }, { ...valid(), requestId: 'not-a-uuid' }, { ...valid(), requestId: [randomUUID()] }, { ...valid(), requestId: { id: randomUUID() } },
    { ...valid(), jobId: 'secure_vault' }, { ...valid(), jobId: '_egc_schedule_lock_2026-09-22' }, { ...valid(), jobId: ['job-1'] },
    { ...valid(), expectedRevision: '' }, { ...valid(), expectedRevision: [f.revision('job-1')] },
    { ...valid(), clearCollaborators: 'true' }, { ...valid(), clearCollaborators: null }, { ...valid(), clearCollaborators: 1 }, [], null,
  ]) {
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(await code(response), 'CUSTOMER_PORTAL_REVOKE_INVALID_REQUEST', JSON.stringify(body));
  }
  const stale = await post({ ...valid(), expectedRevision: '2026-01-01T00:00:00.000000Z' });
  assert.equal(stale.status, 409);
  assert.equal(await code(stale), 'CUSTOMER_PORTAL_REVOKE_REVISION_CONFLICT');
  assert.equal(await code(await post({ ...valid(), jobId: 'missing-job' })), 'CUSTOMER_PORTAL_REVOKE_JOB_NOT_FOUND');
  assert.equal(f.writes(), 0, 'rejected requests write nothing');

  const first = valid(), applied = await post(first);
  assert.equal(applied.status, 200);
  assert.equal((await applied.json()).linkVersion, 1);
  const replay = await (await post(first)).json();
  assert.deepEqual([replay.replayed, replay.linkVersion, replay.clearCollaborators, replay.removedCollaboratorCount], [true, 1, true, 1]);
  assert.equal((await (await post({ ...first, clearCollaborators: true })).json()).replayed, true, 'an omitted flag and an explicit true are the same request');
  assert.equal(await code(await post({ ...first, clearCollaborators: false })), 'CUSTOMER_PORTAL_REVOKE_IDEMPOTENCY_CONFLICT');
  assert.equal(f.job('job-1').customerPortalLinkVersion, 1, 'a retried request never bumps twice');
  const reused = await post({ ...first, expectedRevision: f.revision('job-1') });
  assert.equal(reused.status, 409);
  assert.equal(await code(reused), 'CUSTOMER_PORTAL_REVOKE_IDEMPOTENCY_CONFLICT');
  assert.equal(await code(await post({ ...first, requestId: randomUUID() })), 'CUSTOMER_PORTAL_REVOKE_REVISION_CONFLICT', 'a second revoke must observe the new revision');
  const second = await (await post(valid())).json();
  assert.equal(second.linkVersion, 2);
  assert.equal((await (await get('?jobId=job-1')).json()).linkVersion, 2);
});

test('revoking from a recurring job bumps its verified account root', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const f = firestore(t, { 'job-1': baseJob({ customerAccountOwnerJobId: 'root', customerCollaborators: [] }), root: baseJob() });
  const api = customerPortalRevokeHandlers({ session: async () => manager, now: () => new Date(NOW) });
  const oldSession = await verifyCustomerPortalSessionToken(env, await createCustomerPortalSessionToken(env, 'job-1', NOW, { linkVersion: 0 }), NOW);
  assert.equal((await readCustomerPortalContext(env, oldSession)).accountJobId, 'root');
  const status = await (await api.get({ env, request: staffRequest('/api/customer-portal-revoke?jobId=job-1', '') })).json();
  assert.deepEqual([status.jobId, status.accountJobId, status.revision], ['job-1', 'root', f.revision('root')]);
  const result = await (await api.post({ env, request: staffRequest('/api/customer-portal-revoke', '', { requestId: randomUUID(), jobId: 'job-1', expectedRevision: status.revision }) })).json();
  assert.deepEqual([result.accountJobId, result.linkVersion], ['root', 1]);
  assert.equal(f.job('root').customerPortalLinkVersion, 1);
  assert.deepEqual([result.removedCollaboratorCount, f.job('root').customerCollaborators], [1, []], 'the account root’s authorized people are cleared');
  assert.equal(f.job('job-1').customerPortalLinkVersion, undefined);
  await assert.rejects(() => readCustomerPortalContext(env, oldSession), { code: 'CUSTOMER_PORTAL_ACCESS_REVOKED' });

  f.edit('root', { customerId: 'another-customer' });
  const writes = f.writes();
  const review = await api.post({ env, request: staffRequest('/api/customer-portal-revoke', '', { requestId: randomUUID(), jobId: 'job-1', expectedRevision: f.revision('root') }) });
  assert.equal(review.status, 409);
  assert.equal((await review.json()).code, 'CUSTOMER_PORTAL_REVOKE_ACCOUNT_REVIEW');
  const link = await customerPortalLinkHandler({ now: () => new Date(NOW) })({ env, request: staffRequest('/api/customer-portal-link', await hubCookie('ZacB'), { job_id: 'job-1' }) });
  assert.equal(link.status, 409, 'staff are not handed a link that could never open');
  assert.equal(f.writes(), writes);
});

test('a revoked link is not revived by moving its job under another account root', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const f = firestore(t, { 'job-1': baseJob({ customerCollaborators: [] }), 'root-b': baseJob({ customerCollaborators: [] }) }), zac = await hubCookie('ZacB');
  const linkApi = customerPortalLinkHandler({ now: () => new Date(NOW) });
  const createLink = async () => accessOf((await (await linkApi({ env, request: staffRequest('/api/customer-portal-link', zac, { job_id: 'job-1' }) })).json()).url);
  const bound = await createLink(), boundSession = cookieOf(await exchange(bound)), unbound = await legacyToken('access');
  const api = customerPortalRevokeHandlers({ session: async () => manager, now: () => new Date(NOW) });
  assert.equal((await api.post({ env, request: staffRequest('/api/customer-portal-revoke', '', { requestId: randomUUID(), jobId: 'job-1', expectedRevision: f.revision('job-1') }) })).status, 200);
  for (const access of [bound, unbound]) assert.equal((await exchange(access)).headers.get('location'), '/customer-portal?error=invalid');

  // Staff later attach job-1 to another root of the same customer whose
  // version was never bumped (both roots would accept version 0).
  f.edit('job-1', { customerAccountOwnerJobId: 'root-b' });
  assert.equal((await exchange(bound)).headers.get('location'), '/customer-portal?error=invalid', 'the bound link names the old root');
  const response = await portalGet(boundSession);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'CUSTOMER_PORTAL_ACCESS_REVOKED');
  assert.equal((await exchange(unbound)).headers.get('location'), '/customer-portal', 'tokens without a root claim keep today’s behavior');
  const fresh = await createLink(), claims = await verifyCustomerPortalAccessToken(env, fresh, NOW);
  assert.deepEqual([claims.linkVersion, claims.linkRoot], [0, 'root-b']);
  assert.equal((await portalGet(cookieOf(await exchange(fresh)))).status, 200);
});

function memoryStore(rows) {
  const docs = new Map();
  let counter = 0;
  const put = (key, data) => docs.set(key, { ...structuredClone(data), revision: `revision-${++counter}` });
  for (const [id, data] of Object.entries(rows)) put(`jobs/${id}`, data);
  const store = {
    commits: 0, beforeCommit: null, afterCommit: null,
    async read(collection, id) { const row = docs.get(`${collection}/${id}`); return row ? { ...structuredClone(row), id } : null; },
    async commit(writes) {
      await store.beforeCommit?.();
      const keys = writes.map(write => `${write.collection}/${write.id}`);
      assert.equal(new Set(keys).size, keys.length);
      for (const [index, write] of writes.entries()) {
        if (write.revision ? docs.get(keys[index])?.revision !== write.revision : docs.has(keys[index])) throw Object.assign(new Error('changed'), { code: 'dispatch_revision_conflict', status: 409 });
      }
      for (const [index, write] of writes.entries()) { const { revision, ...old } = docs.get(keys[index]) || {}; put(keys[index], { ...old, ...write.patch }); }
      store.commits += 1;
      await store.afterCommit?.();
    },
    edit(id, patch) { const { revision, ...old } = docs.get(`jobs/${id}`); put(`jobs/${id}`, { ...old, ...patch }); },
    job: id => docs.get(`jobs/${id}`),
  };
  return store;
}

test('concurrent edits, lost responses and retries never double-bump or fake success', async () => {
  const store = memoryStore({ 'job-1': baseJob() }), now = new Date(NOW).toISOString();
  const request = () => ({ requestId: randomUUID(), jobId: 'job-1', expectedRevision: store.job('job-1').revision });

  const raced = request();
  store.beforeCommit = async () => { store.beforeCommit = null; store.edit('job-1', { notes: 'Concurrent staff edit' }); };
  await assert.rejects(() => revokeCustomerPortalLinks(store, manager, raced, { now }), { code: 'CUSTOMER_PORTAL_REVOKE_REVISION_CONFLICT', status: 409 });
  assert.equal(store.job('job-1').customerPortalLinkVersion, undefined);

  const lostBeforeWrite = request();
  store.beforeCommit = async () => { store.beforeCommit = null; throw Object.assign(new Error('lost'), { code: 'dispatch_outcome_unknown' }); };
  await assert.rejects(() => revokeCustomerPortalLinks(store, manager, lostBeforeWrite, { now }), { code: 'CUSTOMER_PORTAL_REVOKE_OUTCOME_UNKNOWN', status: 503 });
  assert.equal(store.commits, 0);
  const retried = await revokeCustomerPortalLinks(store, manager, lostBeforeWrite, { now });
  assert.deepEqual([retried.linkVersion, retried.replayed], [1, undefined]);

  const lostAfterWrite = request();
  store.afterCommit = async () => { store.afterCommit = null; throw Object.assign(new Error('lost'), { code: 'dispatch_outcome_unknown' }); };
  const recovered = await revokeCustomerPortalLinks(store, manager, lostAfterWrite, { now });
  assert.deepEqual([recovered.linkVersion, recovered.replayed], [2, true], 'a saved revocation is recovered from its receipt');
  assert.equal(store.commits, 2);

  assert.equal((await revokeCustomerPortalLinks(store, manager, lostBeforeWrite, { now })).linkVersion, 1, 'older receipts replay their own outcome');
  store.edit('job-1', { customerPortalLinkVersion: 0 });
  await assert.rejects(() => revokeCustomerPortalLinks(store, manager, lostBeforeWrite, { now }), { code: 'CUSTOMER_PORTAL_REVOKE_CHANGED_SINCE_OPERATION' });
  await assert.rejects(() => revokeCustomerPortalLinks(store, { ...manager, user: 'tylerg' }, lostBeforeWrite, { now }), { code: 'CUSTOMER_PORTAL_REVOKE_IDEMPOTENCY_CONFLICT' });
});

test('accepted-quote invitations embed the account link version current at send time', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const approved = baseJob({ phone: '(970) 555-0123', email: 'synthetic@example.invalid', estimate: { status: 'accepted', amount: 1000 }, highlevelContactId: 'contact-1', customerPortalLinkVersion: 2 });
  const f = firestore(t, { 'job-1': approved });
  assert.equal((await sendAcceptedQuotePortal(env, 'job-1')).status, 'submitted');
  assert.equal(f.messages.length, 1);
  const access = accessOf(f.messages[0].message.match(/https:\/\/\S+/)[0]), claims = await verifyCustomerPortalAccessToken(env, access, NOW);
  assert.deepEqual([claims.jobId, claims.linkVersion, claims.linkRoot], ['job-1', 2, 'job-1']);
  assert.equal(JSON.stringify(f.job('job-1')).includes(access), false, 'the bearer link is never stored on the job');
  assert.equal((await exchange(access)).headers.get('location'), '/customer-portal');
  f.edit('job-1', { customerPortalLinkVersion: 3 });
  assert.equal((await exchange(access)).headers.get('location'), '/customer-portal?error=invalid', 'a later revocation also ends the invitation link');
});

test('an account with an unverifiable link version is never sent an invitation', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const f = firestore(t, { 'job-1': baseJob({ phone: '(970) 555-0123', estimate: { status: 'accepted', amount: 1000 }, highlevelContactId: 'contact-1', customerPortalLinkVersion: 'corrupt' }) });
  assert.equal((await sendAcceptedQuotePortal(env, 'job-1')).status, 'storage_unavailable');
  assert.equal(f.messages.length, 0);
  assert.equal(f.writes(), 0, 'no delivery claim is recorded, so a corrected account can still be sent later');
});
