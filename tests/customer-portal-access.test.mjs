import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createHubSessionCookie } from '../functions/_lib/hub-session.js';
import { createCustomerPortalSessionCookie, createCustomerPortalCollaboratorAccessToken, verifyCustomerPortalSessionToken } from '../functions/_lib/customer-portal.js';
import { encodeFirestoreFields, decodeFirestoreFields } from '../functions/_lib/firestore-job.js';
import * as portal from '../functions/api/customer-portal.js';
import * as exchange from '../functions/api/customer-portal-session.js';
import * as upload from '../functions/api/drive-upload.js';

const origin = 'https://easygaragecleaning.com';
const env = {
  HUB_SESSION_SECRET: 'synthetic-portal-hub-secret', CUSTOMER_PORTAL_SECRET: 'synthetic-customer-secret',
  FIREBASE_API_KEY: 'firebase-test-customer-access',
  HUB_AUTH_USERS_JSON: JSON.stringify({ ZacB: { passwordHash: 'synthetic-hash', role: 'owner' } }),
  GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', GOOGLE_REFRESH_TOKEN: 'synthetic-refresh',
};
const permissions = { view: true, decide: true, pay: true, rebook: true };
const person = () => ({ id: 'person-1', name: 'Synthetic Person', email: 'person@example.invalid', status: 'active', permissions: { ...permissions } });
const request = (path, cookie, body) => new Request(origin + path, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const cookieFor = async (jobId = 'job-1', actorId = '') => (await createCustomerPortalSessionCookie(env, jobId, { actorId, permissions })).split(';')[0];
const get = cookie => portal.onRequestGet({ env, request: request('/api/customer-portal', cookie) });
const post = (cookie, body) => portal.onRequestPost({ env, request: request('/api/customer-portal', cookie, body) });

function fixture(t, initial = {}) {
  const jobs = new Map(Object.entries({ 'job-1': { customer: 'Synthetic Customer', type: 'job', total: 400, customerCollaborators: [person()], ...initial } }));
  const calls = [], writes = [];
  t.mock.method(globalThis, 'fetch', async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET';
    calls.push({ url, method, body: options.body });
    if (url.hostname === 'firestore.googleapis.com') {
      const jobId = decodeURIComponent(url.pathname.split('/').pop());
      if (!jobs.has(jobId)) return Response.json({}, { status: 404 });
      if (method === 'PATCH') {
        writes.push(jobId);
        jobs.set(jobId, { ...jobs.get(jobId), ...decodeFirestoreFields(JSON.parse(options.body).fields) });
      }
      return Response.json({ name: `projects/egcw-1ec83/databases/(default)/documents/jobs/${jobId}`, updateTime: '2026-09-07T00:00:00Z', fields: encodeFirestoreFields(jobs.get(jobId)) });
    }
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic-google-token', expires_in: 3600 });
    if (url.pathname === '/drive/v3/files') return Response.json({ files: [{ id: url.searchParams.get('q')?.includes('egcJobId') ? 'synthetic-job-folder' : 'synthetic-root' }] });
    if (url.pathname === '/upload/drive/v3/files') return Response.json({ id: 'synthetic-photo' });
    throw new Error(`Unexpected synthetic request: ${url.hostname}${url.pathname}`);
  });
  return { jobs, calls, writes };
}

test('customer access follows saved collaborator permissions and removal immediately', async t => {
  const f = fixture(t), cookie = await cookieFor('job-1', 'person-1');
  assert.equal((await get(cookie)).status, 200);
  f.jobs.get('job-1').customerCollaborators[0].permissions = { view: true, decide: false, pay: false, rebook: false };
  const view = await (await get(cookie)).json();
  assert.deepEqual(view.viewer.permissions, { view: true, decide: false, pay: false, rebook: false });
  for (const action of ['approve_estimate', 'respond_decision', 'create_payment', 'verify_payment', 'apply_gift_credit', 'request_rebook']) {
    assert.equal((await post(cookie, { action })).status, 403, action);
  }
  assert.equal(f.writes.length, 0);
  // New permissions also take effect without forcing the customer to resend.
  f.jobs.get('job-1').customerCollaborators[0].permissions.rebook = true;
  assert.equal((await post(cookie, { action: 'request_rebook', kind: 'repeat', timing: 'asap' })).status, 200);
  f.jobs.get('job-1').customerCollaborators = [];
  const denied = await get(cookie);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, 'CUSTOMER_PORTAL_ACCESS_REVOKED');
  assert.equal((await post(cookie, { action: 'send_message', body: 'No longer authorized', request_id: 'synthetic-removed-message' })).status, 403);
  assert.equal(f.writes.length, 1, 'removed people cannot send or save anything');
  assert.equal((await get(await cookieFor())).status, 200, 'the primary customer retains access');
});

test('recurring job permissions use the account source and never its stale copied people', async t => {
  const f = fixture(t, { customerAccountOwnerJobId: 'account-job' });
  f.jobs.set('account-job', { customerCollaborators: [] });
  const cookie = await cookieFor('job-1', 'person-1');
  assert.equal((await get(cookie)).status, 403);
  f.jobs.set('account-job', { customerCollaborators: [person()] });
  assert.equal((await get(cookie)).status, 200);
  f.jobs.delete('account-job');
  assert.equal((await get(cookie)).status, 503, 'an unavailable account cannot reactivate a stale copied invitation');
});

test('removed, inactive and view-disabled collaborators cannot exchange an old invite', async t => {
  const f = fixture(t), token = await createCustomerPortalCollaboratorAccessToken(env, 'job-1', 'person-1', permissions);
  const access = () => exchange.onRequestGet({ env, request: new Request(`${origin}/api/customer-portal-session?access=${encodeURIComponent(token)}`) });
  for (const people of [[], [{ ...person(), status: 'removed' }], [{ ...person(), status: 'inactive' }], [{ ...person(), permissions: { view: false } }]]) {
    f.jobs.get('job-1').customerCollaborators = people;
    const response = await access();
    assert.equal(response.headers.get('location'), '/customer-portal?error=invalid');
    assert.equal(response.headers.has('set-cookie'), false);
  }
  f.jobs.get('job-1').customerCollaborators = [{ ...person(), permissions: { view: true, pay: false, decide: true, rebook: false } }];
  const response = await access();
  assert.equal(response.headers.get('location'), '/customer-portal');
  const cookie = response.headers.get('set-cookie').split(';')[0].split('=')[1];
  assert.deepEqual((await verifyCustomerPortalSessionToken(env, cookie)).permissions, { view: true, decide: true, pay: false, rebook: false });
});

test('a temporary account lookup failure never calls a valid customer invitation expired', async t => {
  fixture(t, { customerAccountOwnerJobId: 'temporarily-unavailable-account' });
  const token = await createCustomerPortalCollaboratorAccessToken(env, 'job-1', 'person-1', permissions);
  const response = await exchange.onRequestGet({ env, request: new Request(`${origin}/api/customer-portal-session?access=${encodeURIComponent(token)}`) });
  assert.equal(response.headers.get('location'), '/customer-portal?error=unavailable');
  assert.equal(response.headers.has('set-cookie'), false);
});

const photos = [{ id: 'synthetic-photo', tag: 'before', dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSsoAAAAASUVORK5CYII=' }];
test('portal photo uploads use their project when both customer and Hub cookies exist', async t => {
  const f = fixture(t), customer = await cookieFor(), hub = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  for (const body of [{ uploadContext: 'customer_portal', jobId: 'wrong-job', photos }, { photos }]) {
    f.calls.length = 0;
    const response = await upload.onRequestPost({ env, request: request('/api/drive-upload', `${hub}; ${customer}`, body) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.uploaded, ['synthetic-photo']);
    assert.equal(result.folderUrl, undefined, 'customer responses retain their private limited shape');
    const query = f.calls.find(call => call.url.searchParams.get('q')?.includes('egcJobId'))?.url.searchParams.get('q');
    assert.match(query, /value='job-1'/);
    assert.doesNotMatch(query, /wrong-job/);
  }
  const staff = await upload.onRequestPost({ env, request: request('/api/drive-upload', `${hub}; ${customer}`, { jobId: 'staff-job', photos }) });
  assert.equal(staff.status, 200);
  assert.match((await staff.json()).folderUrl, /drive\.google\.com/);
});

test('photo upload rejects collaborators and missing portal access before creating Drive files', async t => {
  const f = fixture(t), hub = (await createHubSessionCookie(env, 'ZacB')).split(';')[0];
  for (const actor of [person(), { ...person(), status: 'removed' }]) {
    f.jobs.get('job-1').customerCollaborators = [actor];
    const response = await upload.onRequestPost({ env, request: request('/api/drive-upload', await cookieFor('job-1', 'person-1'), { uploadContext: 'customer_portal', photos }) });
    assert.equal(response.status, 403);
  }
  assert.equal((await upload.onRequestPost({ env, request: request('/api/drive-upload', hub, { uploadContext: 'customer_portal', photos }) })).status, 401);
  assert.equal(f.calls.length, 0);
});

test('quiet portal refresh hides revoked access and clears the retained customer data', async () => {
  const source = readFileSync(new URL('../customer-portal.html', import.meta.url), 'utf8');
  const lines = source.split(/\r?\n/), errors = [];
  const context = { portalData: { customer: { name: 'Old Customer' } }, Error, showError: error => errors.push(error),
    fetch: async () => ({ ok: false, json: async () => ({ code: 'CUSTOMER_PORTAL_ACCESS_REVOKED', error: 'Your access to this private project has changed.' }) }) };
  vm.runInNewContext(lines.find(line => line.startsWith('function portalError(')) + '\n' + lines.find(line => line.startsWith('async function load(')), context);
  await context.load(true);
  assert.equal(context.portalData, null);
  assert.equal(errors.length, 1);
  assert.match(source, /uploadContext:'customer_portal'/);
});

for (const code of ['CUSTOMER_PORTAL_AUTH_REQUIRED', 'CUSTOMER_PORTAL_ACCESS_REVOKED']) {
  test(`payment errors restore the button safely after ${code} clears portal data`, async () => {
    const source = readFileSync(new URL('../customer-portal.html', import.meta.url), 'utf8');
    const lines = source.split(/\r?\n/), errors = [], messages = [], handlers = {};
    const button = { disabled: false, textContent: 'Pay $400 securely', addEventListener: (event, handler) => { handlers[event] = handler; } };
    const context = {
      portalData: { payment: { balance: 400 } }, Error,
      $: id => { assert.equal(id, 'pay-button'); return button; },
      showError: error => errors.push(error), toast: message => messages.push(message),
      fetch: async () => ({ ok: false, json: async () => ({ ok: false, code, error: 'Open your private project link again.' }) }),
      location: { assign: () => assert.fail('failed access cannot open Stripe') },
    };
    vm.runInNewContext([
      lines.find(line => line.startsWith('function portalError(')),
      lines.find(line => line.startsWith('async function api(')),
      lines.find(line => line.startsWith("$('pay-button').addEventListener('click'")),
    ].join('\n'), context);
    await handlers.click();
    assert.equal(context.portalData, null);
    assert.deepEqual(errors, ['Open your private project link again.']);
    assert.deepEqual(messages, errors);
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, 'Pay $400 securely');
  });
}
